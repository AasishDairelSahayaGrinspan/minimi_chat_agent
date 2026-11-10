// Seed script: writes a few honestly backdated demo turns into the
// "demo" conversation, so a reviewer can test temporal and memory
// questions immediately instead of waiting days for history to build.
//
// Dates are computed relative to today at run time:
//   - the Postgres hosting turn lands on last Tuesday
//   - the CRM shortlist turn lands on last Monday
//   - the Notion pricing turn lands on the most recent 3 November
// so "last Tuesday", "on Monday" and "on 3 November" always resolve.
//
// Run: npm run seed   (safe to re-run: it replaces the demo turns)

import { randomUUID } from "node:crypto";
import { loadMemory, replaceConversation } from "../src/memory.js";
import { buildSnapshot } from "../src/extract.js";
import { toDateLocal } from "../src/dates.js";

function daysAgoWeekday(targetDay, now) {
  const d = new Date(now);
  d.setHours(11, 0, 0, 0);
  let delta = (d.getDay() - targetDay + 7) % 7;
  if (delta === 0) delta = 7; // "last Tuesday" never means today
  d.setDate(d.getDate() - delta);
  return d;
}

function lastNovember3(now) {
  let d = new Date(now.getFullYear(), 10, 3, 11, 0, 0, 0);
  if (d > now) d = new Date(now.getFullYear() - 1, 10, 3, 11, 0, 0, 0);
  return d;
}

const now = new Date();
const lastTuesday = daysAgoWeekday(2, now);
const lastMonday = daysAgoWeekday(1, now);
const nov3 = lastNovember3(now);

function turn(when, question, answer, sources) {
  return {
    id: randomUUID(),
    timestamp: when.toISOString(),
    dateLocal: toDateLocal(when),
    question,
    answer,
    sources,
    snapshot: buildSnapshot(question, answer, sources),
  };
}

const turns = [
  turn(
    nov3,
    "What does Notion cost for a small team?",
    "For a small team, Notion Plus is $10 per user per month billed annually, and Notion Business is $15 per user per month billed annually. The free plan covers individuals and very small teams, but Plus is where most small teams land because of the longer page history and guest seats. [1] [2]",
    [
      { title: "Notion Pricing", url: "https://www.notion.com/pricing", snippet: "Plus and Business plan pricing per user per month.", publishedDate: null },
      { title: "Notion Help: Plans and billing", url: "https://www.notion.com/help/plans", snippet: "Differences between Free, Plus and Business plans.", publishedDate: null },
    ]
  ),
  turn(
    lastMonday,
    "We need to shortlist CRM tools for a 20-person sales team. What are the best options?",
    "Here is a shortlist of 5 CRM tools that fit a 20-person sales team: 1) HubSpot Sales Hub Starter at $20 per user per month, strong ecosystem and easy onboarding. 2) Pipedrive Essential at $14 per user per month, the most sales-pipeline focused of the five. 3) Zoho CRM Standard at $20 per user per month, good value with lots of automation. 4) Freshsales Growth at $15 per user per month, clean interface and built-in calling. 5) Salesforce Starter at $25 per user per month, heavier to set up but the most extensible. For 20 people, Pipedrive or Freshsales keep the monthly bill lowest, while HubSpot wins on ecosystem. [1] [2] [3]",
    [
      { title: "HubSpot Sales Hub Pricing", url: "https://www.hubspot.com/pricing/sales", snippet: "Starter, Professional and Enterprise tiers.", publishedDate: null },
      { title: "Pipedrive Pricing", url: "https://www.pipedrive.com/en/pricing", snippet: "Essential, Advanced and Professional plans per user per month.", publishedDate: null },
      { title: "Zoho CRM Pricing", url: "https://www.zoho.com/crm/pricing.html", snippet: "Standard, Professional and Enterprise editions.", publishedDate: null },
    ]
  ),
  turn(
    lastTuesday,
    "What are the best Postgres hosting options and what do they cost?",
    "The main Postgres hosting options are: Supabase Pro at $25 per month, which bundles database, auth and storage. Neon Scale at $19 per month, with serverless autoscaling and branching. Railway at $5 per month for the Hobby plan, simple but less Postgres-specific. Aiven for PostgreSQL starts higher, aimed at teams that need multi-cloud. For most small teams I would start with Supabase Pro at $25 per month or Neon, depending on whether you want the extra platform features or pure database branching. [1] [2]",
    [
      { title: "Supabase Pricing", url: "https://supabase.com/pricing", snippet: "Pro plan pricing and included quotas.", publishedDate: null },
      { title: "Neon Pricing", url: "https://neon.tech/pricing", snippet: "Launch and Scale plan pricing.", publishedDate: null },
      { title: "Railway Pricing", url: "https://railway.app/pricing", snippet: "Hobby and Pro plans.", publishedDate: null },
    ]
  ),
].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

await loadMemory();
await replaceConversation("demo", turns);

console.log("Seeded the 'demo' conversation with 3 backdated turns:");
for (const t of turns) {
  console.log(`- ${t.dateLocal}: ${t.question}`);
  console.log(`  snapshot prices: ${(t.snapshot.money || []).join(", ") || "none"}`);
}
console.log("");
console.log("Now run: npm run dev, open http://localhost:3000 and try:");
console.log('- "What did I ask you about Postgres hosting last Tuesday? Has pricing changed?"');
console.log('- "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?"');
console.log('- "What did I ask you on 3 November? Is your answer still correct today?"');
