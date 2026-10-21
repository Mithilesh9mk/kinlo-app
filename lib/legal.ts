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
 *   - a monitored GRIEVANCE_EMAIL
 *   - the governing-law / courts choice in the Terms (currently India)
 *   - the real Gold price and billing provider once payments go live
 * Until they are known, the text uses only "Kinlo", "we" and the email
 * address, so nothing false is shown to users.
 */

/** Bump when the text materially changes — DPDP expects users to be able to
 *  tell which notice they consented to. */
export const LEGAL_VERSION = '0.2-draft';
export const LEGAL_LAST_UPDATED = '21 October 2026';

/** Placeholder — the website is not built yet. Replace these three (and only
 *  these) once it is live; nothing else in the app needs to change. Play
 *  requires the deletion URL to be reachable WITHOUT signing in. */
export const PUBLIC_WEBSITE_URL = 'https://kinlo.app';
export const PUBLIC_PRIVACY_URL = `${PUBLIC_WEBSITE_URL}/privacy`;
export const PUBLIC_TERMS_URL = `${PUBLIC_WEBSITE_URL}/terms`;
export const PUBLIC_DELETION_URL = `${PUBLIC_WEBSITE_URL}/delete-account`;

/** A real monitored address is mandatory in India — the Grievance Officer
 *  must be a named person, not a role alias (see header). */
export const GRIEVANCE_EMAIL = 'privacy@kinlo.app';

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
  'Expense amounts, descriptions, categories and dates you enter',
  'Who you split expenses with, and the balances that result',
  'Your name, email or phone number used to sign in, and an optional profile avatar',
  'UPI IDs you save, used to pre-fill a payment in your UPI app',
  'Phone numbers from your contacts, IF you turn on contact sync — these are sent to Kinlo servers to find matches',
  'Payment screenshots you choose to scan, which are sent to AI services (Anthropic Claude or Google Gemini) to read the amount and merchant',
  'Personal expenses and reminders you log privately, which are never shared with anyone',
  'A device token used to deliver push notifications, if you allow them',
  'Your plan (Free or Gold) and any coupon you redeem',
] as const;

export const PRIVACY_POLICY: LegalDocument = {
  title: 'Privacy Policy',
  sections: [
    {
      heading: 'In short',
      body: [
        'Kinlo helps you split shared expenses and keep track of who owes whom. We never move money — when you settle up, Kinlo hands the payment over to your own UPI app.',
        'We collect what is needed to do that, we tell you before anything leaves your phone, we do not sell your data, and we do not show ads.',
        'This policy applies to everyone who uses Kinlo, wherever you live. The section “Your rights, by region” explains the extra rights you have under the laws of India, the EU/UK, the United States and Australia.',
      ],
    },
    {
      heading: 'What we collect',
      body: [
        ...DATA_PRACTICES,
        'Basic technical information needed to keep the service working, such as error logs and the app version. We do not use third-party advertising or behavioural analytics SDKs.',
      ],
    },
    {
      heading: 'Why we use it (and our legal basis)',
      body: [
        'To run the app: calculate balances, show shared expenses to the people in them, sign you in, keep your plan, and send notifications you have allowed. This is necessary to provide the service you asked for.',
        'To keep it safe: prevent abuse, enforce usage limits (such as the monthly receipt-scan allowance), investigate errors.',
        'Optional features run only on your choice and consent: contact sync, push notifications, receipt scanning, and two-factor authentication. You can withdraw consent at any time by turning the feature off.',
        'To meet legal duties, for example responding to a lawful request or a deletion request.',
      ],
    },
    {
      heading: 'Your contacts',
      body: [
        'When you add a friend, Kinlo opens your phone’s own contact picker. You choose one person, and only that person’s name and number are used. Nothing else is read.',
        'Contact sync is separate and off unless you turn it on. If you turn it on, Kinlo takes the phone numbers from your contacts and sends them to our servers to check which of them already use Kinlo. Numbers that do not match are not kept as a profile.',
        'You can turn contact sync off at any time in your Profile.',
      ],
    },
    {
      heading: 'Receipt and payment screenshots',
      body: [
        'If you scan a payment screenshot, the image is sent to an AI vision service (Anthropic Claude or Google Gemini), which reads the amount, merchant and date from it. The provider processes the image to return that result.',
        'The image is stored in your private area of our storage so you can see what a figure came from later. Only you can access it.',
        'The temporary copy on your phone is deleted once the upload finishes. Do not scan screenshots that show information you do not want processed, such as full card numbers.',
      ],
    },
    {
      heading: 'Reminders and notifications',
      body: [
        'Reminders you create (title, optional amount, date) are stored in your account so they survive a new phone, and are visible only to you. Reminder alerts are scheduled on your device.',
        'Push notifications use a device token. You can turn notifications off in your phone’s settings at any time.',
      ],
    },
    {
      heading: 'Kinlo Gold, payments and coupons',
      body: [
        'Kinlo has a free plan and a paid plan, Kinlo Gold. We store which plan you are on, when it started and ends, and any coupon you redeemed.',
        'Gold purchases are handled by the app store or payment provider shown at checkout. They process your payment details; Kinlo does not see or store your card or bank details.',
        'Separately, Kinlo never moves money between people. Settling up between friends happens in your own UPI app.',
      ],
    },
    {
      heading: 'Who can see your data',
      body: [
        'People you share an expense or a group with can see that expense, its amount, and the balance between you. That is the point of the app. They can also see your name and avatar.',
        'Personal expenses and reminders you log on your own are visible only to you.',
        'We do not sell or rent your data, and we do not use it for advertising or share it for cross-context behavioural advertising.',
      ],
    },
    {
      heading: 'Who processes data for us',
      body: [
        'Supabase — database, authentication and file storage.',
        'Anthropic and Google (Claude / Gemini API) — reading payment screenshots you choose to scan.',
        'Expo — app delivery, updates and push notifications.',
        'Google Play / Apple App Store, and any payment provider shown at checkout — Gold purchases.',
        'These providers act on our instructions and only for these purposes. We may disclose data if the law or a valid legal order requires it.',
      ],
    },
    {
      heading: 'Where your data is stored',
      body: [
        'Our service providers may process data on servers outside your country, including outside India, the EU/UK and Australia. Where the law requires it, we rely on appropriate safeguards for such transfers, such as standard contractual clauses or the provider’s certified protections.',
      ],
    },
    {
      heading: 'How long we keep data',
      body: [
        'We keep your data while your account is active. Personal expenses, reminders, drafts, friendships, push token and your name, phone, avatar and UPI ID are erased when you delete your account.',
        'Shared expenses are also other people’s financial records. When you delete your account they are kept but stripped of your identity: they show a nameless participant, so other people’s balances and history are not rewritten.',
        'Scanned screenshots are removed with your account. Backups are overwritten on the normal backup cycle.',
      ],
    },
    {
      heading: 'Deleting your account',
      body: [
        'Delete your account in the app from Profile → Data & Export Compliance. The app shows what will be erased and what will remain before you confirm. Outstanding balances do not block deletion.',
        `You can also ask us to delete your data by writing to ${GRIEVANCE_EMAIL}. We will confirm the request and complete it within a reasonable time and within any period the law requires.`,
      ],
    },
    {
      heading: 'Your rights, by region',
      body: [
        'Everywhere: you can ask for a copy of your data, ask us to correct it, ask us to delete your account and data, and withdraw consent for optional features. Use the in-app options or write to us.',
        'India (Digital Personal Data Protection Act, 2023): you are a “Data Principal”. You have the right to access a summary of your data and who it is shared with, to correct and erase it, to withdraw consent, to nominate someone to exercise your rights if you die or are incapacitated, and to a response to your grievance. If we do not resolve a grievance, you may complain to the Data Protection Board of India.',
        'European Economic Area and United Kingdom (GDPR / UK GDPR): you have the rights of access, rectification, erasure, restriction, objection and data portability, and the right not to be subject to solely automated decisions with significant effects (Kinlo makes none). You may lodge a complaint with your local data-protection authority, such as the UK ICO.',
        'United States: depending on your state (for example California under the CCPA/CPRA, and other states with similar laws) you may have the right to know, access, correct, delete and obtain a portable copy of your personal information, and to opt out of its sale or sharing. We do not sell or share personal information for advertising. We will not discriminate against you for exercising these rights. An authorised agent may make a request for you.',
        'Australia (Privacy Act 1988 and the Australian Privacy Principles): you may ask to access or correct your personal information. If you are not satisfied with our response, you may complain to us and then to the Office of the Australian Information Commissioner (OAIC).',
        `To exercise any right, email ${GRIEVANCE_EMAIL}. We may need to confirm it is you before acting.`,
      ],
    },
    {
      heading: 'Keeping data safe',
      body: [
        'Data is encrypted in transit. Access is restricted so that you can only read rows you are a party to, enforced by the database itself rather than by the app. You can turn on two-factor authentication in Profile → Security & Privacy.',
        'No system is perfectly secure. If a breach affects your data, we will notify you and the relevant authority as the law requires.',
      ],
    },
    {
      heading: 'Children',
      body: [
        'Kinlo is not intended for anyone under 18. We do not knowingly collect data from children. If you believe a child has given us data, contact us and we will remove it.',
      ],
    },
    {
      heading: 'Grievance Officer and contact',
      body: [
        'If you have a question or complaint about how your data is handled, contact us. We will acknowledge your message and respond within the timeframes required by the law that applies to you (for India, the DPDP Act and its rules).',
        `Email: ${GRIEVANCE_EMAIL}`,
      ],
    },
    {
      heading: 'Changes',
      body: [
        `This policy was last updated on ${LEGAL_LAST_UPDATED}. If we change it materially, we will tell you in the app before the change applies to you.`,
      ],
    },
  ],
};

export const TERMS_OF_SERVICE: LegalDocument = {
  title: 'Terms of Service',
  sections: [
    {
      heading: 'What Kinlo is',
      body: [
        'Kinlo is a record-keeping tool for shared expenses. It calculates who owes whom based on what you and the people you share with enter.',
        'Kinlo does not hold, transfer or manage money. When you settle up, Kinlo opens your own UPI app with the details filled in. The payment happens entirely between you, the other person, and your payment providers.',
      ],
    },
    {
      heading: 'The numbers are yours',
      body: [
        'Balances are calculated from what people enter. Kinlo cannot verify that an expense really happened or that an amount is correct. Scanned figures are read by AI and may be wrong — check them before saving.',
        'A balance shown in Kinlo is a record of what was entered, not proof of a debt. Disagreements about money are between you and the people you share with.',
      ],
    },
    {
      heading: 'Your account',
      body: [
        'You must be at least 18 and able to enter a binding agreement.',
        'You are responsible for keeping your login details secure and for what is entered from your account. We recommend turning on two-factor authentication.',
        'Give accurate information. Do not use Kinlo to impersonate someone else.',
      ],
    },
    {
      heading: 'Adding people who have not joined',
      body: [
        'You can add someone who does not use Kinlo yet, so you can record expenses with them. If that person later joins with the same phone number, both of you must confirm before any shared history is connected to their account.',
        'Only add people you have a real reason to share expenses with.',
      ],
    },
    {
      heading: 'Free plan and Kinlo Gold',
      body: [
        'Kinlo is free to use with a monthly allowance of receipt scans. Kinlo Gold is a paid plan that removes that limit and adds other benefits described on the Gold screen. Benefits may change over time; we will not remove a benefit you have already paid for during the period you paid for.',
        'Prices are shown in the app before you buy. Gold is billed through the app store or payment provider shown at checkout, so renewal, cancellation and refunds follow that provider’s rules. A subscription renews automatically until you cancel it in your store account, and cancelling takes effect at the end of the paid period.',
        'Refunds: you can request a refund from the store you bought through. Nothing in these terms limits any refund or cancellation right you have by law, including consumer rights in your country (for example statutory cooling-off rights in the EU/UK, and the consumer guarantees under the Australian Consumer Law).',
      ],
    },
    {
      heading: 'Coupons',
      body: [
        'A coupon code gives the benefit stated when it was issued, for the period stated. Codes are single-use unless stated, cannot be exchanged for cash, can be withdrawn if they are misused, and cannot be resold.',
      ],
    },
    {
      heading: 'Acceptable use',
      body: [
        'Do not use Kinlo for anything unlawful, to harass anyone, or to attempt to access data belonging to other people. Do not try to bypass usage limits, reverse engineer the service, or overload it. We may suspend an account that breaks these rules.',
      ],
    },
    {
      heading: 'Your content',
      body: [
        'You keep ownership of what you enter. You give us permission to store and process it, and to show it to the people you share it with, only so that we can provide Kinlo.',
      ],
    },
    {
      heading: 'Availability and changes',
      body: [
        'We aim to keep Kinlo working but cannot promise it will always be available or error-free. Features may change. We may update these terms; if the change is material we will tell you in the app first, and continuing to use Kinlo afterwards means you accept it.',
      ],
    },
    {
      heading: 'Limits of liability',
      body: [
        'To the extent the law allows, Kinlo is provided as-is, and we are not liable for losses arising from calculation errors, scanning errors, lost data, or payments made through third-party apps. Our total liability to you for any claim is limited to the amount you paid us for Kinlo in the 12 months before the claim, or ₹1,000 if you paid nothing.',
        'Nothing in these terms excludes or limits liability that cannot be excluded by law, including for fraud, or rights you have as a consumer that cannot be waived (including under the Consumer Protection Act 2019 in India, consumer law in the EU/UK, and the Australian Consumer Law).',
      ],
    },
    {
      heading: 'Governing law',
      body: [
        'These terms are governed by the laws of India, and the courts of India have jurisdiction, except that if you are a consumer in another country, you also keep the benefit of the mandatory consumer-protection laws and courts of the place you live.',
      ],
    },
    {
      heading: 'Ending your use',
      body: [
        'You can stop using Kinlo and delete your account at any time from Profile → Data & Export Compliance. What happens to your data is explained in the Privacy Policy.',
      ],
    },
    {
      heading: 'Contact',
      body: [`Questions about these terms: ${GRIEVANCE_EMAIL}`],
    },
  ],
};

export const LEGAL_DOCS: Record<string, LegalDocument> = {
  privacy: PRIVACY_POLICY,
  terms: TERMS_OF_SERVICE,
};
