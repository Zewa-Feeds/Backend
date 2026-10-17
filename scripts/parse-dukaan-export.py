"""
Parses the two Dukaan exports into scripts/dukaan/dukaan-import.json, the input
to import-dukaan.ts. Read-only: touches no database.

    python3 scripts/parse-dukaan-export.py <orders.xlsx> <customers.xlsx>

Sources (the old zewafeeds.com store, run on Dukaan until Sep 2026):
  - "all-orders-till-19-sep-2026…xlsx"  one row per LINE ITEM, 69 columns
  - "Zewa_Customer_List.xlsx"           sheet "Raw Export (as-is)", one row per customer

Output lands in scripts/dukaan/, which is gitignored: it carries customers'
phone numbers and home addresses, and has no business in the repo.

DECISIONS (agreed 3 Oct 2026):

  * A person with no email ANYWHERE — not on the customer list, not on any of
    their orders — is skipped and written to dukaan-skipped.csv instead.
    Customer.email and Order.email are required, and a placeholder address
    would be a fake contact for a real person (same reasoning as the Amazon
    review import). Those records stay in the spreadsheet until email is
    made optional.
  * A person is keyed by their Dukaan customer, not by phone. Dukaan merged
    customers by email: Soorya S placed #24450353 from a second number that
    is not on the customer list, and the list counts it against them. Phone
    first, then email, reproduces exactly that grouping.
  * A person with an email on SOME orders carries it onto all of them — the
    email is theirs; the order row simply did not repeat it.

Every figure is checked rather than trusted: each order must satisfy
lines + delivery - discount == order total to the paisa, and each customer's
order count and sales must match the customer list. Any mismatch aborts.
"""
import csv
import json
import os
import re
import sys
from collections import OrderedDict, defaultdict
from datetime import datetime, timedelta, timezone

import openpyxl

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dukaan")
IST = timezone(timedelta(hours=5, minutes=30))

# Dukaan's line statuses. "Failed" lines all carry shipment status "RTO
# completed": the parcel came back undelivered.
STATUS = {
    "Delivered": "DELIVERED",
    "Cancelled (Cust.)": "CANCELLED",
    "Failed": "CANCELLED",
}

# The pack code embedded in Dukaan's size attribute, e.g. "size - F3 (0.6mm-0.8mm)".
CODE_RE = re.compile(r"\b(F2|F3|G2|C4|C5|K4|P5|M2|DBSFL)\b")
MULTIPACK_RE = re.compile(r"Pack of ([23])")


def blank(v):
    return v is None or str(v).strip() in ("", "-", "None")


def clean(v):
    return None if blank(v) else str(v).strip()


def ten(phone):
    return re.sub(r"\D", "", str(phone or ""))[-10:]


def paise(rupees):
    return int(round(float(rupees or 0) * 100))


def ist(s):
    """'14 Feb 2024 07:06 PM' (IST, as Dukaan exports it) -> UTC ISO string."""
    if blank(s):
        return None
    return (
        datetime.strptime(s.strip(), "%d %b %Y %I:%M %p")
        .replace(tzinfo=IST)
        .astimezone(timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


def sku_and_pack(line):
    """
    The SKU as sold, and the pack label.

    Dukaan's own SKU wins whenever it gave one — including the barcode
    1102021006142 on the 2024 Micro Pellets listing, which is what that line
    really was. Only a BLANK SKU is derived, from the pack code in the size
    attribute and the weight in the product name, and is flagged as derived.
    """
    name = line["Product Name"]
    attr = clean(line["Attribute Value 1"]) or ""
    given = clean(line["SKU ID"])

    m = MULTIPACK_RE.search(attr)
    count = int(m.group(1)) if m else 1
    low = name.lower()
    if "1kg" in low.replace(" ", ""):
        weight, pack = "1KG", "1kg Pouch"
    elif "75 grams" in low:
        weight, pack = "75G", "75g"
    elif "25 grams" in low or name == "Dried Black Soldier Fly Larvae":
        weight, pack = "25G", "25g"
    elif "65g" in low:
        weight, pack = "65G", "65g / 125ml"
    else:
        weight, pack = "45G", "45g Bottle"
    if count > 1:
        pack = f"{pack.split(' ')[0]} — Pack of {count}"

    if given:
        return given, pack, False

    code = CODE_RE.search(attr)
    code = code.group(1) if code else ("DBSFL" if "Soldier Fly" in name else None)
    if not code:
        raise SystemExit(f"Cannot derive a SKU for {line['Order ID']}: {name!r} / {attr!r}")
    return f"{code}-{weight}" + (f"X{count}" if count > 1 else ""), pack, True


def jsonable(row):
    return {k: (v if isinstance(v, (int, float, bool)) or v is None else str(v)) for k, v in row.items()}


def main(orders_path, customers_path):
    wb = openpyxl.load_workbook(orders_path, read_only=True, data_only=True)
    rows = list(wb.worksheets[0].iter_rows(values_only=True))
    # Rows 0-3 are a title and a labelled grand-totals block; row 4 is the header.
    header = rows[4]
    lines = [dict(zip(header, r)) for r in rows[5:] if r[0] is not None]
    report_total = rows[3][rows[2].index("Total Order cost currently")]

    wc = openpyxl.load_workbook(customers_path, read_only=True, data_only=True)
    craw = list(wc["Raw Export (as-is)"].iter_rows(values_only=True))
    customers = [dict(zip(craw[0], r)) for r in craw[1:] if r[0] is not None]

    by_order = OrderedDict()
    for l in lines:
        by_order.setdefault(l["Order ID"], []).append(l)

    # ---- people ------------------------------------------------------------
    by_phone = {ten(c["Mobile Number"]): c for c in customers}
    by_email = {c["Email"].strip().lower(): c for c in customers if clean(c["Email"])}

    def owner(ls):
        c = by_phone.get(ten(ls[0]["Mobile Number"]))
        if c:
            return c
        em = clean(ls[0]["Email Address"])
        c = by_email.get(em.lower()) if em else None
        if not c:
            raise SystemExit(f"Order {ls[0]['Order ID']} matches no customer on the list")
        return c

    orders_of = defaultdict(list)
    for oid, ls in by_order.items():
        orders_of[owner(ls)["Customer ID"]].append(oid)

    people, skipped = [], []
    for c in customers:
        oids = orders_of.get(c["Customer ID"], [])
        email = clean(c["Email"])
        if not email:
            for oid in oids:
                email = email or next((clean(l["Email Address"]) for l in by_order[oid] if clean(l["Email Address"])), None)
        latest = by_order[oids[-1]][0] if oids else None
        person = {
            "dukaanCustomerId": str(c["Customer ID"]),
            "name": c["Customer Name"].strip(),
            "firstName": (clean(latest["Customer first Name"]) if latest else None) or c["Customer Name"].strip(),
            "lastName": (clean(latest["Customer last Name"]) if latest else None) or "",
            "email": email.lower() if email else None,
            "emailFrom": "customer list" if clean(c["Email"]) else ("order" if email else None),
            "phone": ten(c["Mobile Number"]),
            "city": clean(c["City"]),
            "listTotalOrders": c["Total Orders"],
            "listTotalSalesRupees": c["Total Sales (₹)"],
            "orderIds": oids,
            "raw": jsonable(c),
        }
        (people if email else skipped).append(person)

    # ---- orders -------------------------------------------------------------
    orders = []
    for oid, ls in by_order.items():
        first = ls[0]
        statuses = {STATUS[l["Line Item Order Status"]] for l in ls}
        if len(statuses) != 1:
            raise SystemExit(f"{oid}: lines disagree on status {statuses}")
        status = statuses.pop()

        items = []
        for l in ls:
            sku, pack, derived = sku_and_pack(l)
            qty = int(l["Total Qty Ordered"])
            line_total = paise(l["Line Item Value"])
            if line_total % qty:
                raise SystemExit(f"{oid}: line value {line_total} not divisible by qty {qty}")
            items.append({
                "productName": l["Product Name"].strip(),
                "sku": sku,
                "skuDerived": derived,
                "pack": pack,
                "qty": qty,
                "unitPricePaise": line_total // qty,
                "lineTotalPaise": line_total,
                "discountPaise": paise(l["Discount Value (Delivery Discount + Coupon Discount + Online Order Payment Discount)"]),
            })

        subtotal = sum(i["lineTotalPaise"] for i in items)
        # Delivery is spread across lines in fractional rupees (10.5696…);
        # sum first, round once.
        shipping = paise(sum(float(l["Buyer Delivery Charge"] or 0) for l in ls))
        discount = sum(i["discountPaise"] for i in items)
        total = paise(first["Order Cost at the time of placing"])
        if subtotal + shipping - discount != total:
            raise SystemExit(f"{oid}: {subtotal} + {shipping} - {discount} != {total}")
        if paise(first["Order Cost Currently"]) != total or paise(first["Payment amounts"]) != total:
            raise SystemExit(f"{oid}: order cost changed after placing, or payment differs")
        if any(str(l["Payment statuses"]) != "Completed" for l in ls):
            raise SystemExit(f"{oid}: payment not completed")

        coupons = sorted({l["Coupon Name"] for l in ls if clean(l["Coupon Name"])})
        if len(coupons) > 1:
            raise SystemExit(f"{oid}: several coupons {coupons}")

        cancel_reason = None
        if first["Line Item Order Status"] == "Failed":
            cancel_reason = "Delivery failed — returned to origin (RTO completed on Dukaan)"
        elif status == "CANCELLED":
            cancel_reason = clean(first["Cancellation Reason"]) or "Cancelled by customer"

        line2 = ", ".join(
            p for p in [
                clean(first["Address Line 2"]),
                clean(first["Locality"]),
                f"Landmark: {clean(first['Landmark'])}" if clean(first["Landmark"]) else None,
            ] if p
        )
        state = clean(first["State"])
        orders.append({
            "dukaanOrderId": oid.lstrip("#"),
            "dukaanSystemId": str(first["System ID"]),
            "dukaanCustomerId": str(owner(ls)["Customer ID"]),
            "customerPhone": ten(first["Mobile Number"]),
            "orderEmail": clean(first["Email Address"]),
            "status": status,
            "cancelReason": cancel_reason,
            "placedAt": ist(first["Received Date/Time"]),
            "deliveredAt": ist(first["Delivered Date"]) if status == "DELIVERED" else None,
            # Dukaan records no cancellation time; the last modification is it.
            "cancelledAt": ist(first["Last Modified Date/Time"]) if status == "CANCELLED" else None,
            "subtotalPaise": subtotal,
            "shippingPaise": shipping,
            "discountPaise": discount,
            "totalPaise": total,
            "couponCode": coupons[0] if coupons else None,
            "shippingAddress": {
                "name": first["Customer Name"].strip(),
                "line1": clean(first["Address Line 1"]),
                "line2": line2 or None,
                "city": clean(first["City"]),
                "state": state.title() if state and state.islower() else state,
                "pincode": str(first["Pincode"]).strip(),
                "phone": ten(first["Mobile Number"]),
            },
            "items": items,
            "raw": [jsonable(l) for l in ls],
        })

    # ---- reconcile against the customer list ---------------------------------
    paid_by = defaultdict(lambda: [0, 0])
    for o in orders:
        cid = int(o["dukaanCustomerId"])
        paid_by[cid][0] += 1
        # The list's "Total Sales" excludes cancelled and failed orders.
        if o["status"] != "CANCELLED":
            paid_by[cid][1] += o["totalPaise"]
    for c in customers:
        n, s = paid_by[c["Customer ID"]]
        if n != c["Total Orders"] or s != paise(c["Total Sales (₹)"]):
            raise SystemExit(f"{c['Customer Name']}: list says {c['Total Orders']} / ₹{c['Total Sales (₹)']}, orders give {n} / {s/100}")
    if sum(o["totalPaise"] for o in orders) != paise(report_total):
        raise SystemExit("orders do not sum to the report's grand total")

    os.makedirs(OUT_DIR, exist_ok=True)
    kept = {p["dukaanCustomerId"] for p in people}
    out = {
        "source": "Dukaan",
        "exportedThrough": "2026-09-19",
        "customers": people,
        "orders": [o for o in orders if o["dukaanCustomerId"] in kept],
    }
    with open(os.path.join(OUT_DIR, "dukaan-import.json"), "w") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)

    with open(os.path.join(OUT_DIR, "dukaan-skipped.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Dukaan Customer ID", "Name", "Phone", "City", "Orders", "Sales (₹)", "Dukaan Order IDs", "Reason"])
        for p in skipped:
            w.writerow([p["dukaanCustomerId"], p["name"], p["phone"], p["city"], p["listTotalOrders"],
                        p["listTotalSalesRupees"], " ".join(p["orderIds"]), "No email on customer list or any order"])

    skipped_orders = sum(len(p["orderIds"]) for p in skipped)
    print(f"customers: {len(people)} to import, {len(skipped)} skipped (no email)")
    print(f"orders:    {len(out['orders'])} to import, {skipped_orders} skipped with them "
          f"({len(orders)} in export, all reconciled to the paisa)")
    print(f"derived SKUs on {sum(i['skuDerived'] for o in out['orders'] for i in o['items'])} lines")
    print(f"wrote {OUT_DIR}/dukaan-import.json and dukaan-skipped.csv")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2])
