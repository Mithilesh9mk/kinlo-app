/**
 * Legal document content and links.
 *
 * WHY THE TEXT LIVES IN THE APP, NOT ONLY ON A WEBSITE
 *
 * Both stores require the privacy policy to be reachable from inside the
 * app, not just from the store listing — and India's DPDP notice
 * requirements are about what the user is actually shown before they
 * consent, which a store listing does not satisfy. Keeping the text here
 * means it is available offline, at signup, before any permission prompt.
 *
 * A public URL is ALSO required (Play Console and App Store Connect both
 * demand one, and Play separately requires a deletion page reachable
 * without logging in). Set PUBLIC_* below once the site is live; they are
 * used for the store listings and for sharing, not for in-app display.
 *
 * ⚠️ DRAFT — NOT LEGALLY REVIEWED. The text below is written against what
 * Kinlo actually does today (see DATA_PRACTICES) and covers India (DPDP Act
 * 2023), the EU/EEA/UK (GDPR), the United States (CCPA/CPRA and similar
 * state laws) and Australia (Privacy Act 1988 / APPs). It is a starting
 * point, not legal advice, and must be reviewed by a lawyer in each market
 * before the app is submitted to a store. Presence of this file is not
 * compliance.
 *
 * FACTS ONLY THE OWNER CAN SUPPLY (deliberately not invented here):
 *   - the legal entity name and registered address that operates Kinlo
 *   - the named Grievance Officer (DPDP) and, if one is required, the EU/UK
 *     representative and a data-protection contact
 *   - a working STUDIO_EMAIL (until it exists the text says "Studio email coming soon.")
 *   - the governing-law / courts choice in the Terms (currently India)
 *   - the real Gold price and billing provider once payments go live
 * Until they are known, the text uses only "Kinlo", "we" and the email
 * address, so nothing false is shown to users.
 */

/** Bump when the text materially changes — DPDP expects users to be able to
 *  tell which notice they consented to. */
export const LEGAL_VERSION = '1.0';
export const LEGAL_LAST_UPDATED = '18 November 2026';
/** Same date as LEGAL_LAST_UPDATED until the owner sets a different one. */
export const LEGAL_EFFECTIVE_DATE = '18 November 2026';

/** ONE-PLACE DOMAIN CONFIG. Nothing else in the app or the website generator
 *  hard-codes a domain. See DOMAIN_DAY.md.
 *
 *  PUBLIC_WEBSITE_URL is the planned Kinlo site. It is not live yet, so
 *  WEBSITE_LIVE stays false: the app shows no web links and the website
 *  footer shows no parent-site links until you flip it on domain day.
 *  Play and the App Store both need the deletion URL reachable WITHOUT
 *  signing in, so it must be live before store submission. */
export const WEBSITE_LIVE = false;
export const PUBLIC_WEBSITE_URL = 'https://kinlo.tummytimestudio.com';
export const PUBLIC_PRIVACY_URL = `${PUBLIC_WEBSITE_URL}/privacy`;
export const PUBLIC_TERMS_URL = `${PUBLIC_WEBSITE_URL}/terms`;
export const PUBLIC_DELETION_URL = `${PUBLIC_WEBSITE_URL}/delete-account`;

/** Parent brand site. Planned pages: privacy.html and terms.html. Leave empty
 *  until they are live, so no dead link ships. */
export const PARENT_SITE_URL = '';
export const PARENT_PRIVACY_URL = PARENT_SITE_URL ? `${PARENT_SITE_URL}/privacy.html` : '';
export const PARENT_TERMS_URL = PARENT_SITE_URL ? `${PARENT_SITE_URL}/terms.html` : '';

/** Links the legal screen shows under the text. Empty until WEBSITE_LIVE. */
export function webLegalLinks(): { label: string; url: string }[] {
  if (!WEBSITE_LIVE) return [];
  const links = [
    { label: 'Privacy Policy on the web', url: PUBLIC_PRIVACY_URL },
    { label: 'Terms of Service on the web', url: PUBLIC_TERMS_URL },
    { label: 'Delete your account on the web', url: PUBLIC_DELETION_URL },
  ];
  if (PARENT_SITE_URL) {
    links.push(
      { label: 'Tummy Time Studio privacy', url: PARENT_PRIVACY_URL },
      { label: 'Tummy Time Studio terms', url: PARENT_TERMS_URL },
    );
  }
  return links;
}

/** The studio email for privacy, rights, deletion and complaints.
 *  Planned: hello@tummytimestudio.com. It does not exist yet, so this stays
 *  empty and every page says "Studio email coming soon." The mailbox must
 *  exist before Play submission. When it does, set it here and regenerate the
 *  website: that is the only edit. */
export const STUDIO_EMAIL = '';
export const CONTACT_LINE = STUDIO_EMAIL || 'Studio email coming soon.';

export interface LegalSection {
  heading: string;
  body: string[];
}

export interface LegalDocument {
  title: string;
  sections: LegalSection[];
}

/**
 * The specific things Kinlo does that a policy MUST disclose. Kept as its
 * own list so it can be cross-checked against the Play Data Safety form and
 * the App Store privacy labels — those three must agree, and they drift
 * apart easily when each is written separately.
 */
export const DATA_PRACTICES = [
  'Your email address and a password, or your Google account, used to sign in',
  'Your name, an optional phone number, an optional profile avatar and your base currency',
  'Expense amounts, descriptions, categories and dates you enter',
  'Who you split expenses with, and the balances that result',
  'UPI IDs you save, used to pre-fill a payment in your UPI app',
  'Phone numbers from your contacts, only if you turn on contact sync. They are sent to Kinlo servers to find matches',
  'Payment screenshots and receipt photos you choose to scan. They are stored in your private area and sent to AI services (Anthropic Claude or Google Gemini) to read the amount, merchant and date',
  'Personal expenses and reminders you log privately, which are never shared with anyone',
  'A device token used to deliver push notifications, if you allow them',
  'A random identifier for your app install (not your hardware ID), used only to limit abuse of free-plan limits',
  'Your plan (Free or Gold) and any coupon you redeem',
] as const;

export const PRIVACY_POLICY: LegalDocument = {
  title: 'Privacy Policy',
  sections: [
    {
      heading: 'In short',
      body: [
        'Kinlo helps you split shared expenses and keep track of who owes whom. We never move money. When you settle up, Kinlo opens your own UPI app with the details filled in.',
        'Kinlo is a free Android preview build, distributed from GitHub. It is not on the Play Store.',
        'We collect what is needed to run the app. We tell you before anything leaves your phone. We do not sell your data and we do not show ads.',
        `This policy is effective from ${LEGAL_EFFECTIVE_DATE}.`,
      ],
    },
    {
      heading: 'Who runs Kinlo',
      body: [
        'Mithilesh Kale, an individual in Pune, India, runs Kinlo under the brand name Tummy Time Studio. Tummy Time Studio is not a registered company.',
      ],
    },
    {
      heading: 'What we collect',
      body: [
        ...DATA_PRACTICES,
        'Kinlo has no analytics, advertising or crash-reporting SDK. If the app crashes, a short error note is saved on your phone only. It is not sent to us.',
        'Our providers keep ordinary server logs, such as request errors, for a limited period under their own policies.',
      ],
    },
    {
      heading: 'Why we use it',
      body: [
        'To run the app: sign you in, calculate balances, show shared expenses to the people in them, keep your plan, and send notifications you have allowed.',
        'To keep it safe: limit abuse. We rate-limit sign-in, coupon, phone-lookup, receipt-scan, delete-account and notification requests. The monthly receipt-scan allowance is also counted per app install, so extra accounts on one phone do not reset it.',
        'Optional features run only if you choose them: contact sync, push notifications, receipt scanning and two-factor authentication. You can turn each one off.',
        'To meet legal duties, for example a deletion request.',
      ],
    },
    {
      heading: 'Your contacts',
      body: [
        'When you add a friend, Kinlo opens your phone’s own contact picker. You choose one person, and only that person’s name and number are used.',
        'Contact sync is separate and off unless you turn it on. If you turn it on, Kinlo sends the phone numbers from your contacts to our servers to check which of them already use Kinlo. The numbers are used for that check. They are not saved as profiles.',
        'You can turn contact sync off at any time in your Profile.',
      ],
    },
    {
      heading: 'Receipt and payment screenshots',
      body: [
        'If you scan a payment screenshot or receipt photo, the image is uploaded to your private area of our storage. Our server then sends it to an AI vision service (Anthropic Claude or Google Gemini) to read the amount, merchant and date.',
        'Only you can open the stored image. It is deleted when you delete your account.',
        'Do not scan images that show information you do not want processed, such as full card numbers.',
      ],
    },
    {
      heading: 'Reminders and notifications',
      body: [
        'Reminders you create (title, optional amount, date) are stored in your account and are visible only to you.',
        'Push notifications use a device token, sent through Expo’s push service. You can turn notifications off in your phone’s settings at any time.',
      ],
    },
    {
      heading: 'Kinlo Gold and coupons',
      body: [
        'Kinlo has a Free plan and a Gold plan. Today Gold comes from a coupon code or is granted by the owner. Kinlo does not take payments and does not see or store any card or bank details.',
        'We store which plan you are on, when Gold ends, and any coupon you redeemed.',
        'Kinlo never moves money between people. Settling up happens in your own UPI app.',
      ],
    },
    {
      heading: 'Who can see your data',
      body: [
        'People you share an expense or a group with can see that expense, its amount, and the balance between you. They can also see your name and avatar.',
        'Personal expenses and reminders you log on your own are visible only to you.',
        'We do not sell or rent your data. We do not use it for advertising.',
      ],
    },
    {
      heading: 'Who processes data for us',
      body: [
        'Supabase: database, sign-in and file storage.',
        'Google: sign-in with Google, if you choose it, and receipt reading through Gemini.',
        'Anthropic: receipt reading through Claude.',
        'Expo: app updates and push notifications.',
        'These providers act on our instructions and only for these purposes. We may disclose data if the law or a valid legal order requires it.',
      ],
    },
    {
      heading: 'Where your data is stored',
      body: [
        'Your data is stored with our hosting provider, Supabase. Our database runs in Supabase’s Seoul, South Korea region. Our service providers may process data on servers outside your country. Where the law requires it, we rely on appropriate safeguards for such transfers.',
      ],
    },
    {
      heading: 'How long we keep data',
      body: [
        'We keep your data while your account is active.',
        'When you delete your account we erase: your personal expenses, expense drafts, reminders, repeating expenses, friendships, push token, name, phone number, avatar and UPI ID, your scanned images, and your login. People you added who never joined are also removed, if they have no shared expenses.',
        'Shared expenses are also other people’s financial records. They are kept but stripped of your identity. They show a participant called “Deleted user”, so other people’s balances and history are not rewritten.',
        'Deleted data leaves backups on our provider’s schedule.',
      ],
    },
    {
      heading: 'Deleting your account',
      body: [
        'Delete your account in the app from Profile → Data & Export Compliance. The app shows what will be erased and what will remain before you confirm. Outstanding balances do not block deletion.',
        'Deletion takes effect when you confirm. If it fails part-way, the app tells you.',
        `You can also ask us to delete your data by email. ${CONTACT_LINE} We reply to privacy, rights and deletion requests within 30 days.`,
      ],
    },
    {
      heading: 'Your rights',
      body: [
        'You can ask for a copy of your data, ask us to correct it, ask us to delete your account and data, and withdraw consent for optional features. Use the in-app options or write to us.',
        'The law where you live may give you more rights, for example under India’s Digital Personal Data Protection Act, 2023, or the GDPR in the EU and UK. We will respect the rights the law gives you.',
        `To exercise a right, write to the studio email in “Contact and complaints” below. We may need to confirm it is you first. We reply to privacy, rights and deletion requests within 30 days. If we have not resolved your complaint, you can complain to the Data Protection Board of India.`,
      ],
    },
    {
      heading: 'Keeping data safe',
      body: [
        'Data is encrypted in transit. Access rules in the database let you read only the rows you are part of. You can turn on two-factor authentication in your Profile.',
        'No system is perfectly secure. If a breach affects your data, we will tell you as the law requires.',
      ],
    },
    {
      heading: 'Children',
      body: [
        'Kinlo is for people aged 18 or over. We do not knowingly collect data from anyone younger. If you believe a child has given us data, contact us and we will remove it.',
      ],
    },
    {
      heading: 'Contact and complaints',
      body: [
        `Mithilesh Kale, the sole operator, handles questions, requests and complaints. Contact is by email. ${CONTACT_LINE} We do not publish a postal address.`,
      ],
    },
    {
      heading: 'Changes',
      body: [
        `This policy was last updated on ${LEGAL_LAST_UPDATED}. If we change it in a way that matters, we will tell you in the app first.`,
      ],
    },
  ],
};

export const TERMS_OF_SERVICE: LegalDocument = {
  title: 'Terms of Service',
  sections: [
    {
      heading: 'Who runs Kinlo',
      body: [
        'Mithilesh Kale, an individual in Pune, India, runs Kinlo under the brand name Tummy Time Studio. Tummy Time Studio is not a registered company.',
      ],
    },
    {
      heading: 'What Kinlo is',
      body: [
        'Kinlo is a record-keeping tool for shared expenses. It calculates who owes whom from what you and the people you share with enter.',
        'Kinlo is a free Android preview build, distributed from GitHub. It is not on the Play Store. It is early software and may have bugs.',
        'Kinlo does not hold, transfer or manage money. When you settle up, Kinlo opens your own UPI app with the details filled in. The payment happens between you, the other person and your payment providers.',
        `These terms are effective from ${LEGAL_EFFECTIVE_DATE}.`,
      ],
    },
    {
      heading: 'The numbers are yours',
      body: [
        'Balances come from what people enter. Kinlo cannot check that an expense happened or that an amount is right. Scanned figures are read by AI and may be wrong. Check them before you save.',
        'A balance in Kinlo is a record of what was entered. It is not proof of a debt. Money disagreements are between you and the people you share with.',
      ],
    },
    {
      heading: 'Your account',
      body: [
        'Kinlo is for people aged 18 or over. Do not create an account if you are younger.',
        'You are responsible for your login and for what is entered from your account. We recommend turning on two-factor authentication.',
        'Give accurate information. Do not use Kinlo to pretend to be someone else.',
      ],
    },
    {
      heading: 'Adding people who have not joined',
      body: [
        'You can add someone who does not use Kinlo yet, so you can record expenses with them. If that person later joins with the same phone number, both of you must confirm before shared history is connected to their account.',
        'Only add people you have a real reason to share expenses with.',
      ],
    },
    {
      heading: 'Free plan and Kinlo Gold',
      body: [
        'Kinlo is free to use. The Free plan includes a monthly allowance of receipt scans (currently 3) and a limit on active reminders (currently 3).',
        'Kinlo Gold raises the receipt-scan allowance to 125 a month, removes the reminder limit and adds other benefits shown on the Gold screen. Allowances reset on the 1st of each month, India time.',
        'Today Gold is available only with a coupon code or from the owner. Paid subscriptions are not on sale. If that changes, we will update these terms and tell you in the app first.',
        'Benefits and allowances may change. We will not remove a Gold benefit during a period you already have.',
      ],
    },
    {
      heading: 'Coupons',
      body: [
        'A coupon code gives the benefit stated when it was issued, for the period stated. A code can be redeemed once per account, and some codes have a limited number of uses. It cannot be exchanged for cash or resold. We can withdraw a code that is misused.',
      ],
    },
    {
      heading: 'Acceptable use',
      body: [
        'Do not use Kinlo for anything unlawful, to harass anyone, or to try to reach other people’s data. Do not try to get around usage limits, for example by making several accounts for extra free scans or to reuse a coupon. Do not reverse engineer the service or overload it. We may suspend an account that breaks these rules.',
      ],
    },
    {
      heading: 'Your content',
      body: [
        'You keep ownership of what you enter. You allow us to store and process it, and to show it to the people you share it with, only so that we can run Kinlo. Kinlo’s source code is open source under the MIT licence.',
      ],
    },
    {
      heading: 'Availability and changes',
      body: [
        'We try to keep Kinlo working but cannot promise it will always be available or free of errors. Features may change. If we change these terms in a way that matters, we will tell you in the app first.',
      ],
    },
    {
      heading: 'Limits of liability',
      body: [
        'As far as the law allows, Kinlo is provided as is. We are not liable for losses from calculation errors, scanning errors, lost data, or payments made through other apps.',
        'As far as the law allows, our total liability to you for any claim is limited to the amount you paid us in the 12 months before the claim. While Kinlo is free, that amount is nothing.',
        'Nothing in these terms limits any right you have by law that cannot be waived, including consumer rights where you live.',
      ],
    },
    {
      heading: 'Governing law',
      body: [
        'These terms are governed by the laws of India. The courts at Pune, India have jurisdiction.',
      ],
    },
    {
      heading: 'Ending your use',
      body: [
        'You can stop using Kinlo and delete your account at any time from Profile → Data & Export Compliance. The Privacy Policy explains what happens to your data.',
      ],
    },
    {
      heading: 'Contact and complaints',
      body: [
        `Mithilesh Kale, the sole operator, handles questions, requests and complaints. Contact is by email. ${CONTACT_LINE} We do not publish a postal address.`,
      ],
    },
  ],
};

export const LEGAL_DOCS: Record<string, LegalDocument> = {
  privacy: PRIVACY_POLICY,
  terms: TERMS_OF_SERVICE,
};
