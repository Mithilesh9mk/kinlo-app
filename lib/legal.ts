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
 * ⚠️ DRAFT — NOT LEGALLY REVIEWED. The text below is a starting point
 * written against what Kinlo actually does (see the disclosure list in
 * DATA_PRACTICES). It must be reviewed by a lawyer familiar with India's
 * DPDP Act before the app is submitted to either store. Do not treat the
 * presence of this file as compliance.
 */

/** Bump when the text materially changes — DPDP expects users to be able to
 *  tell which notice they consented to. */
export const LEGAL_VERSION = '0.1-draft';
export const LEGAL_LAST_UPDATED = '26 August 2026';

/** TODO: replace once the site is live. Play requires the deletion URL to be
 *  reachable WITHOUT signing in. */
export const PUBLIC_PRIVACY_URL = 'https://kinlo.app/privacy';
export const PUBLIC_TERMS_URL = 'https://kinlo.app/terms';
export const PUBLIC_DELETION_URL = 'https://kinlo.app/delete-account';

/** TODO: a real monitored address is mandatory in India — the Grievance
 *  Officer must be a named person, not a role alias. */
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
  'Your name, phone number, and optional profile photo',
  'UPI IDs you save, used to pre-fill a payment in your UPI app',
  'Phone numbers from your contacts, IF you turn on contact sync — these are sent to Kinlo servers to find matches',
  'Payment screenshots you choose to scan, which are sent to AI services (Anthropic Claude or Google Gemini) to read the amount and merchant',
  'Personal expenses you log privately, which are never shared with anyone',
] as const;

export const PRIVACY_POLICY: LegalDocument = {
  title: 'Privacy Policy',
  sections: [
    {
      heading: 'In short',
      body: [
        'Kinlo helps you split shared expenses and keep track of who owes whom. We never move money — when you settle up, Kinlo hands the payment over to your own UPI app.',
        'We collect what is needed to do that, and we tell you before anything leaves your phone.',
      ],
    },
    {
      heading: 'What we collect',
      body: [
        ...DATA_PRACTICES,
        'Basic technical information needed to keep the service working, such as crash and error logs.',
      ],
    },
    {
      heading: 'Your contacts',
      body: [
        'When you add a friend, Kinlo opens your phone’s own contact picker. You choose one person, and only that person’s name and number are used. Nothing else is read.',
        'Contact sync is separate and off unless you turn it on. If you turn it on, Kinlo takes the phone numbers from your contacts and sends them to our servers to check which of them already use Kinlo, so we can suggest them as friends. We use them only for that check.',
        'You can turn contact sync off at any time in your Profile.',
      ],
    },
    {
      heading: 'Receipt and payment screenshots',
      body: [
        'If you scan a payment screenshot, the image is sent to an AI vision service (Anthropic Claude or Google Gemini), which reads the amount, merchant and date from it. The provider processes the image on our behalf under their API terms.',
        'The image is stored in your private area of our storage so you can see what a figure came from later. Only you can access it.',
        'The temporary copy on your phone is deleted once the upload finishes.',
      ],
    },
    {
      heading: 'Who can see your data',
      body: [
        'People you share an expense or a group with can see that expense, its amount, and the balance between you. That is the point of the app.',
        'Personal expenses you log on your own are visible only to you.',
        'We do not sell your data, and we do not use it for advertising.',
      ],
    },
    {
      heading: 'Who processes data for us',
      body: [
        'Supabase — database, authentication and file storage.',
        'Anthropic & Google (Claude / Gemini API) — reading payment screenshots you choose to scan.',
        'Expo — app delivery, updates and push notifications.',
      ],
    },
    {
      heading: 'Your rights',
      body: [
        'You can ask for a copy of your data, ask us to correct it, or ask us to delete your account and data.',
        'You can delete your account from Profile → Security & Privacy, or by writing to us at the address below.',
        'If you are in the EU or UK, you also have the rights given by the GDPR. If you are in California, you have the rights given by the CCPA/CPRA.',
      ],
    },
    {
      heading: 'Keeping data safe',
      body: [
        'Data is encrypted in transit. Access is restricted so that you can only read rows you are a party to, enforced by the database itself rather than by the app.',
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
      heading: 'Grievance Officer',
      body: [
        'If you have a complaint about how your data is handled, contact our Grievance Officer. We will acknowledge your complaint and respond within the timeframes required under Indian law.',
        `Email: ${GRIEVANCE_EMAIL}`,
        'TODO: named officer and postal address required before submission.',
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
        'Balances are calculated from what people enter. Kinlo cannot verify that an expense really happened or that an amount is correct.',
        'A balance shown in Kinlo is a record of what was entered, not proof of a debt. Disagreements about money are between you and the people you share with.',
      ],
    },
    {
      heading: 'Your account',
      body: [
        'You are responsible for keeping your login details secure and for what is entered from your account.',
        'Give accurate information. Do not use Kinlo to impersonate someone else.',
      ],
    },
    {
      heading: 'Adding people who have not joined',
      body: [
        'You can add someone who does not use Kinlo yet, so you can record expenses with them. If that person later joins with the same phone number, both of you must confirm before any shared history is connected to their account.',
      ],
    },
    {
      heading: 'Acceptable use',
      body: [
        'Do not use Kinlo for anything unlawful, and do not attempt to access data belonging to other people.',
      ],
    },
    {
      heading: 'Availability',
      body: [
        'We aim to keep Kinlo working but cannot promise it will always be available or error-free. Features may change.',
      ],
    },
    {
      heading: 'Limits',
      body: [
        'To the extent the law allows, Kinlo is provided as-is, and we are not liable for losses arising from calculation errors, lost data, or payments made through third-party apps.',
        'TODO: liability, governing law and dispute resolution clauses require legal drafting.',
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
