/** Last instant of the given date's UTC day — for inclusive `to` filters on a bare `YYYY-MM-DD` param. */
export function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}
