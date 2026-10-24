/**
 * Script to generate a secure CMS invitation / password-reset link for any CMS user.
 *
 * Usage:
 *   npx tsx scripts/generate-reset-link.ts --email <email> [--send]
 *
 * Examples:
 *   # Generate link for Vaishnavi (prints link for manual sharing, does not send email):
 *   npx tsx scripts/generate-reset-link.ts --email vaishnavip@zewafeeds.com
 *
 *   # Generate link and immediately send the transactional email via ZeptoMail:
 *   npx tsx scripts/generate-reset-link.ts --email vaishnavip@zewafeeds.com --send
 */
import { PrismaClient, Role } from '@prisma/client';
import { generateToken, hashToken } from '../src/lib/crypto';
import { accountTemplates } from '../src/integrations/zeptomail/templates';
import { sendEmail } from '../src/integrations/zeptomail/zeptomail.client';
import { env } from '../src/config/env';

const prisma = new PrismaClient();

const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Admin',
  OPS_MANAGER: 'Ops Manager',
  CONTENT_EDITOR: 'Content Editor',
};

async function main() {
  const args = process.argv.slice(2);
  const emailIdx = args.indexOf('--email');
  const sendEmailFlag = args.includes('--send');

  if (emailIdx === -1 || !args[emailIdx + 1]) {
    console.error('Error: Please provide --email <user-email>');
    process.exit(1);
  }

  const email = args[emailIdx + 1].trim().toLowerCase();

  const user = await prisma.cmsUser.findFirst({
    where: { email: { equals: email, mode: 'insensitive' }, deletedAt: null },
  });

  if (!user) {
    console.error(`Error: CMS user with email "${email}" not found.`);
    process.exit(1);
  }

  // 1. Generate 32-byte secure token
  const rawToken = generateToken(32);
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

  // 2. Upsert invitation record so /accept-invitation?token=... can validate it
  await prisma.$transaction(async (tx) => {
    await tx.cmsInvitation.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
      update: {
        tokenHash,
        expiresAt,
        usedAt: null,
        revokedAt: null,
      },
    });

    // Invalidate existing sessions for security
    await tx.cmsUser.update({
      where: { id: user.id },
      data: { tokenVersion: { increment: 1 } },
    });

    await tx.cmsSession.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'password_reset_issued' },
    });
  });

  const cmsOrigin = (env.CMS_ORIGIN && !env.CMS_ORIGIN.includes('localhost'))
    ? env.CMS_ORIGIN.replace(/\/$/, '')
    : 'https://cms.zewafeeds.com';

  const resetUrl = `${cmsOrigin}/accept-invitation?token=${rawToken}`;

  console.log('\n======================================================');
  console.log('  SUCCESSFULLY GENERATED RESET / INVITATION LINK');
  console.log('======================================================');
  console.log(`User Name  : ${user.name}`);
  console.log(`User Email : ${user.email}`);
  console.log(`User Role  : ${ROLE_LABELS[user.role]}`);
  console.log(`User Status: ${user.status}`);
  console.log(`Valid For  : 48 hours (until ${expiresAt.toLocaleString('en-IN')})`);
  console.log('------------------------------------------------------');
  console.log(`Reset URL  :\n${resetUrl}`);
  console.log('======================================================\n');

  if (sendEmailFlag) {
    console.log(`Sending transactional email via ZeptoMail to ${user.email}...`);
    try {
      const template = accountTemplates['cms-user-invitation']({
        recipientName: user.name,
        recipientEmail: user.email,
        roleLabel: ROLE_LABELS[user.role],
        inviteUrl: resetUrl,
        expiresInHours: 48,
      });

      const res = await sendEmail({
        to: [{ email: user.email, name: user.name }],
        subject: `Set your password for Zewa Feeds CMS`,
        htmlBody: template.html,
        reference: `reset-link-${user.id}`,
      });

      console.log('Email delivery result:', res);
      if (res.sent) {
        console.log(`Email successfully delivered to ${user.email}!`);
      } else {
        console.warn('Email was skipped or not delivered by provider.');
      }
    } catch (err: any) {
      console.error('Failed to send email via ZeptoMail:', err?.message || err);
    }
  } else {
    console.log('Note: Email was NOT sent automatically (run with --send to dispatch email).');
    console.log('You can copy the Reset URL above and share it directly with the user.');
  }
}

main()
  .catch((e) => {
    console.error('Unexpected error:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
