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
 * The same policy and terms are published on the website (/privacy, /terms,
 * /delete-account). The two are meant to say the same thing: when you change
 * one, change the other. Play also requires a deletion page that works
 * without signing in, which is the website's /delete-account.
 *
 * NOT LEGALLY REVIEWED. The text is written against what Kinlo actually
 * does today (code, migrations, README) and is meant to be accurate for
 * India (DPDP Act 2023). It makes one general statement about rights under
 * other countries' laws and does not claim region-specific compliance. It is
 * not legal advice; have a lawyer read it before the app is submitted to a
 * store.
 *
 * FACTS THE OWNER MUST CONFIRM BEFORE STORE SUBMISSION
 *   - the operator is written as "Mithilesh Kale, an individual developer in
 *     India" — update if a company or registered address is used
 *   - the public website domain and a monitored grievance email (TODOs below)
 *   - governing law is India with no court city named
 *   - the 30-day deletion-by-email target is a promise the owner must be able
 *     to keep
 *   - when paid Gold goes on sale, add billing, refund and store sections to
 *     both this file and the website (none are here because nothing is sold)
 */

/** Bump when the text materially changes — DPDP expects users to be able to
 *  tell which notice they consented to. Must match the website's date. */
export const LEGAL_VERSION = '1.0';
export const LEGAL_EFFECTIVE_DATE = '31 October 2026';

/**
 * TODO(owner): no domain is owned yet, so this is empty and the "Read this on
 * our website" link stays hidden in the legal screen (websiteUrlFor returns
 * null for an empty value, and app/legal/[doc].tsx only renders the link when
 * it gets a URL). Set it to the real https origin once the site is live;
 * nothing else in the app needs to change. The website serves /privacy,
 * /terms and /delete-account.
 */
export const PUBLIC_WEBSITE_URL = '';
export const PUBLIC_PRIVACY_URL = `${PUBLIC_WEBSITE_URL}/privacy`;
export const PUBLIC_TERMS_URL = `${PUBLIC_WEBSITE_URL}/terms`;
export const PUBLIC_DELETION_URL = `${PUBLIC_WEBSITE_URL}/delete-account`;

/** The named person users can contact (DPDP expects a named grievance contact). */
export const GRIEVANCE_OFFICER_NAME = 'Mithilesh Kale';

/**
 * TODO(owner): PLACEHOLDER. hello@example.com is the same placeholder the
 * website footer uses. Replace it with ONE monitored inbox, identical to the
 * website footer, BEFORE any release or OTA that includes this file: users are
 * told to send privacy and deletion requests here. Do not use an address on a
 * domain you do not own, since whoever registers it would receive them.
 */
export const GRIEVANCE_EMAIL = 'hello@example.com';

/** Website page for each in-app document, or null if the link should be hidden. */
export function websiteUrlFor(doc: string | undefined): string | null {
  if (!PUBLIC_WEBSITE_URL) return null;
  if (doc === 'privacy') return PUBLIC_PRIVACY_URL;
  if (doc === 'terms') return PUBLIC_TERMS_URL;
  return null;
}

export interface LegalSection {
  heading: string;
  body: string[];
}

export interface LegalDocument {
  title: string;
  sections: LegalSection[];
}

/**
 * The specific things Kinlo collects that a policy MUST disclose. Kept as its
 * own list so it can be cross-checked against the Play Data Safety form —
 * those must agree, and they drift apart easily when written separately.
 */
export const DATA_PRACTICES = [
  'Sign-in: your email address and a password, or Google sign-in if you choose it. Supabase Authentication handles the password.',
  'Profile: your name, an optional phone number, an avatar you pick and an optional UPI ID. The UPI ID is used to pre-fill a payment in your UPI app.',
  'Expenses and balances: amounts, descriptions, categories, dates, who paid, each person’s share, circles, settlements, repeating expenses and an activity log.',
  'People you add: the name, and phone number if you enter it, of someone who has not joined Kinlo.',
  'Personal spending and reminders you keep for yourself, which only you can see.',
  'Payment screenshots you choose to scan: the image, the text read from it, and the amount, merchant, date and category found.',
  'A notification token from Expo, if you allow notifications.',
  'A random ID the app creates for your install (not a hardware ID), used to stop free scan and coupon limits being bypassed with extra accounts.',
  'Your plan (Free or Gold), any coupon you redeemed, and short-lived counts of scans, lookups and reminders, used to apply limits and prevent abuse.',
] as const;

export const PRIVACY_POLICY: LegalDocument = {
  title: 'Privacy Policy',
  sections: [
    {
      heading: 'In short',
      body: [
        'Your expenses, balances and friends are stored in a Supabase database. Only the people in a shared expense can see it.',
        'Kinlo has no ads, does not sell data, and the app has no analytics or crash-reporting tools.',
        'A payment screenshot you scan is sent to an AI service (Anthropic, or Google as a backup) to be read.',
        'Your contacts are used only when you pick a friend or turn on contact sync.',
      ],
    },
    {
      heading: 'Who we are',
      body: [
        `Kinlo is made and run by ${GRIEVANCE_OFFICER_NAME}, an individual developer in India. In this policy, “we” means him. You can reach us at ${GRIEVANCE_EMAIL}.`,
      ],
    },
    {
      heading: 'What Kinlo collects',
      body: [
        ...DATA_PRACTICES,
        'If the app hits a fatal error, a note about it is saved on your phone only. It is not sent to us.',
      ],
    },
    {
      heading: 'Scanning a payment screenshot',
      body: [
        'Scanning is optional. When you scan, the image is uploaded to a private storage area that only your account can read, and the image is sent to an AI service to read it.',
        'The AI service gets the image and a fixed instruction that includes today’s date. It does not get your name, email or account ID.',
        'Kinlo asks Anthropic’s Claude first. If that fails or looks unsure, it may ask Google’s Gemini, then a larger Claude model.',
        'What comes back (amount, merchant, date, category and the text on the image) is saved on your personal entry. Check it before you save.',
        'We do not keep the AI conversation. Our server logs note which AI service was called, the status it returned, the type of any error and how long the call took. They do not include the provider’s reply, your image or the details read from it.',
        'Each AI company handles the images it receives under its own terms, and we do not control how long it keeps them. Do not scan screenshots that show card numbers or anything you do not want processed.',
        'In this preview, removing an entry does not remove its image. Deleting your account does.',
        'The free plan allows 3 scans a month per account, and 6 a month in total across all accounts used on one app install. Gold allows 125.',
      ],
    },
    {
      heading: 'Your contacts',
      body: [
        'When you add a friend, your phone’s own contact picker opens. You choose one person, and only that person’s name and number are used.',
        'Contact sync is off until you turn it on. If you do, phone numbers from your contacts (the last ten digits) are sent to our server and checked against Kinlo accounts. Names stay on your phone. The numbers are used to look for matches and are not stored. Kinlo does remember which accounts matched, so that you can add them as friends.',
        'You can turn contact sync off in Profile.',
        'If someone has your number in their contacts and uses contact sync, or types your number to add you, they can see that you use Kinlo, with your name, avatar and phone number.',
      ],
    },
    {
      heading: 'Who can see your data',
      body: [
        'People in a shared expense or circle see that expense, its amount, the balance between you, and your name and avatar. That is the point of the app.',
        'If you send a friend a payment reminder, they get a notification with your name and the amount they owe you.',
        'Your personal spending entries and reminders are visible only to you.',
        'As the person who runs Kinlo, we can technically reach the database to fix problems. We do not browse it for any other reason.',
      ],
    },
    {
      heading: 'Who handles data for us',
      body: [
        'Supabase: database, sign-in, file storage and server functions. It receives everything you store in Kinlo.',
        'Anthropic: reads payment screenshots. It receives the image you scan.',
        'Google (Gemini): backup reader for screenshots. It receives the image, only if the first reader fails or looks unsure.',
        'Google (sign-in): only if you choose Google sign-in. It receives your sign-in details.',
        'Expo: notifications and app updates. It receives your notification token and the message, and update requests from your phone.',
        'GitHub: hosts the preview APK download, under its own policy.',
        'These providers may process data on servers outside India. We may also share data if the law or a valid legal order requires it.',
      ],
    },
    {
      heading: 'What Kinlo does not do',
      body: [
        'It shows no ads.',
        'It does not sell or rent your data.',
        'The app includes no third-party analytics or crash-reporting tools.',
        'It does not move money. Settling up opens your own UPI app.',
      ],
    },
    {
      heading: 'How long we keep data',
      body: [
        'We keep your data while your account exists. When you delete it, your private data is erased, and expenses shared with other people stay with your identity removed. Supabase may keep backups for a while, and we do not control exactly how long.',
      ],
    },
    {
      heading: 'Deleting your account',
      body: [
        'Delete your account in the app from Profile → Data & Export Compliance → Delete Account & Data. The app shows what will be removed and what will stay before you confirm. Outstanding balances do not block deletion. Deleting cannot be undone.',
        'Erased: your login (email, password and Google link); your name, phone number, avatar, UPI ID and notification token; your personal spending entries, reminders and drafts; your friend links and reminder records; your repeating expenses, plan, coupon and scan records and usage counters; your scanned payment screenshots; and people you added who have not joined and have no expense history. Screenshots are removed in batches. If a removal fails, the rest of the deletion still goes ahead and we log how many files failed, so you can email us to check.',
        'Kept, with your identity removed (your name becomes “Deleted user”): shared expenses and their amounts, who paid, each person’s share and settlements, descriptions you wrote on shared expenses, circle memberships and activity entries. People you added who have expense history also stay, with the name and number you entered, because those expenses still need them. These are also other people’s records. Deleting does not cancel money you owe or are owed.',
        `If you cannot open the app, email ${GRIEVANCE_EMAIL} from the address on your account with the subject “Delete my Kinlo account”. We will reply to confirm and aim to finish within 30 days. Never send your password.`,
      ],
    },
    {
      heading: 'Your rights',
      body: [
        'Under India’s Digital Personal Data Protection Act, 2023, you can ask to see a summary of your data, correct it, erase it, withdraw consent, nominate someone to act for you, and have a grievance answered. If we do not resolve a grievance, you may complain to the Data Protection Board of India. If you live elsewhere, local law may give you similar rights.',
        `You can edit your profile and delete your account in the app. For anything else, email ${GRIEVANCE_EMAIL}. We will reply as soon as we can, and within the time the law sets. We may need to confirm it is you first.`,
      ],
    },
    {
      heading: 'Security',
      body: [
        'Data travels over encrypted connections.',
        'Every database table has row-level security, so an account can read only the rows it is part of.',
        'AI and service keys are kept on the server, not in the app.',
        'Scans, lookups and reminders are rate limited.',
        'You can turn on two-factor sign-in with an authenticator app in Profile.',
        'No system is perfectly secure. If a breach affects your data, we will tell you and the authorities as the law requires.',
      ],
    },
    {
      heading: 'Children',
      body: [
        'Kinlo is for people aged 18 and over. We do not knowingly collect data from anyone younger. If you think a child has an account, email us and we will remove it.',
      ],
    },
    {
      heading: 'Changes',
      body: [
        `This policy is effective ${LEGAL_EFFECTIVE_DATE} (version ${LEGAL_VERSION}). If we change it in a way that matters, we will change the date and version, and try to tell you in the app first.`,
      ],
    },
    {
      heading: 'Contact and grievances',
      body: [
        `For questions, requests or complaints, email ${GRIEVANCE_EMAIL}. The grievance contact is ${GRIEVANCE_OFFICER_NAME}.`,
      ],
    },
  ],
};

export const TERMS_OF_SERVICE: LegalDocument = {
  title: 'Terms of Service',
  sections: [
    {
      heading: 'In short',
      body: [
        'Kinlo keeps a record of who owes whom. It never holds or moves money.',
        'Scanned numbers are read by AI and can be wrong. Check them.',
        'This is a preview build, so expect bugs and changes.',
        'These terms are governed by the laws of India.',
      ],
    },
    {
      heading: 'What Kinlo is',
      body: [
        'Kinlo is a record-keeping tool for shared expenses and your own spending. It works out balances from what you and the people you share with enter.',
        'Kinlo does not hold, transfer or process money, and it has no payment gateway. When you settle up, it opens your own UPI app with the details filled in. The payment happens between you, the other person and your payment providers.',
      ],
    },
    {
      heading: 'Your account',
      body: [
        'You must be 18 or older.',
        'Give accurate information and keep your sign-in details safe. You are responsible for what is entered from your account.',
        'One person, one account. Do not pretend to be someone else.',
        'We recommend turning on two-factor sign-in.',
      ],
    },
    {
      heading: 'Using Kinlo properly',
      body: [
        'Do not use Kinlo to break the law, harass anyone, or reach data that belongs to other people. Do not get around its limits, for example by making extra accounts to collect free scans or reuse a coupon. Do not overload or reverse engineer the service beyond what the open-source licence allows. Send reminders reasonably: Kinlo allows one per person per day, and only while a balance is open.',
        'We may suspend an account that breaks these rules.',
      ],
    },
    {
      heading: 'The numbers are records',
      body: [
        'Kinlo cannot check that an expense happened or that an amount is right. A balance shown in Kinlo is a record of what was entered, not proof of a debt. Disagreements about money are between you and the people you share with.',
      ],
    },
    {
      heading: 'Payment screenshot scanning',
      body: [
        'An AI service reads the screenshot. It can misread or miss details, so check the amount, merchant, date and category before you save. What you save is your responsibility.',
        'Only scan screenshots you have the right to use.',
        'The free plan includes 3 scans a month per account, and 6 a month in total across all accounts used on one app install. Gold includes 125. Allowances reset on the 1st of each month (India time) and may change.',
        'Paid plans are not on sale in the preview. Gold is given by coupon or by us. If that changes, the price and billing terms will be shown in the app before you buy, and these terms will be updated.',
      ],
    },
    {
      heading: 'Your content',
      body: [
        'You keep ownership of what you enter. You allow us to store and process it, and to show it to the people you share it with, only so that Kinlo can work. Scanning sends images to the AI providers listed in the Privacy Policy.',
      ],
    },
    {
      heading: 'People who have not joined',
      body: [
        'You can add someone who is not on Kinlo yet and record expenses with them. If they later join with the same phone number, both of you must confirm before any shared history is linked to their account. Only add people you have a real reason to share expenses with.',
      ],
    },
    {
      heading: 'Open source and the Kinlo name',
      body: [
        'The code is open source under the MIT licence. These terms cover using the app and the website, not your rights to the code.',
        'The licence covers code only. The Kinlo name, tagline, logo, icon, launch video and screenshots are not licensed for reuse.',
      ],
    },
    {
      heading: 'The preview service',
      body: [
        'Kinlo is offered as a preview. We aim to keep it working but cannot promise it will always be available or error-free. Features may change or be removed, and we may stop the service. We will try to give notice in the app first.',
      ],
    },
    {
      heading: 'Ending your use',
      body: [
        'You can stop using Kinlo and delete your account at any time from Profile → Data & Export Compliance. What happens to your data is explained in the Privacy Policy. We may suspend or end an account that breaks these terms.',
      ],
    },
    {
      heading: 'Disclaimers',
      body: [
        'To the extent the law allows, Kinlo is provided as it is and as available, with no promise that its calculations, scans or records are error-free. Kinlo is not responsible for UPI apps, AI services or other third-party services you use alongside it.',
      ],
    },
    {
      heading: 'Limit of liability',
      body: [
        'To the extent the law allows, we are not liable for losses from calculation errors, scanning errors, lost data, or payments made through other apps. Our total liability for any claim is limited to what you paid us for Kinlo in the 12 months before the claim, or ₹1,000 if you paid nothing.',
        'Nothing here limits liability that cannot be limited by law, including for fraud, or consumer rights you cannot waive, including under the Consumer Protection Act, 2019.',
      ],
    },
    {
      heading: 'Governing law',
      body: [
        'These terms are governed by the laws of India, and the courts of India have jurisdiction. If you are a consumer in another country, you also keep the mandatory consumer protections of where you live.',
      ],
    },
    {
      heading: 'Changes to these terms',
      body: [
        `These terms are effective ${LEGAL_EFFECTIVE_DATE} (version ${LEGAL_VERSION}). If we change them in a way that matters, we will change the date and version, and try to tell you in the app first. Using Kinlo after a change means you accept it.`,
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
