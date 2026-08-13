# Paid model — design doc

Status: draft for decision. Precedes Batch 2 (quotas) and Batch 3 (membership).

---

## 1. The finding that should shape everything

Inference is **not** our cost driver at student volumes. Measured against the real
perf corpus (70 documents, 1,631 chunks, 97 tokens/chunk average) and gpt-4o-mini
pricing ($0.15/1M input, $0.60/1M output):

| Operation | Tokens (in / out) | Cost |
|---|---|---|
| Course chat message | ~2,000 / 400 | **$0.00054** |
| Quick Help message | ~1,500 / 400 | **$0.00047** |
| Exam insights (whole assessment corpus, cached) | 1,791 / ~800 | **$0.00075** |
| Study guide generation | ~6,000 / 3,000 | **$0.0027** |
| Embedding one uploaded doc | ~3,400 | **$0.00007** |

A **heavy** student — 200 chats, 20 Quick Help, 10 insight views, 5 study guides,
20 uploads in a month — costs roughly:

```
200(.00054) + 20(.00047) + 10(.00075) + 5(.0027) + 20(.00007)  ≈  $0.14 / month
```

**About fourteen cents.**

> **This is a FLOOR, not a ceiling — do not quote it as an upper bound in a pricing
> argument.** It omits: regenerate (now shipped, so every dissatisfied answer doubles
> that message), escalation to a stronger model (~17× input cost), study-guide
> revisions, flashcards, and exam-insights cache churn — the cache key is an
> assessment fingerprint, so during corpus-building every new upload invalidates it
> and "cached" is optimistic exactly when uploads are most frequent.
>
> Even generously multiplied the conclusion holds — it is still ~1–3% of a $15
> subscription — but the honest claim is "inference is a rounding error", not
> "$0.14".

Two consequences:

1. **Do not price to cover marginal AI cost.** Price for value. The margin is
   already there; the risk is elsewhere.
2. **Quotas are an abuse and blast-radius control, not a margin control.** That
   changes how generous the free tier can be, and it means a quota breach should
   read as "something is wrong" rather than "a user is costing us money."

### OCR — MEASURED, and why the real argument is still availability

**Measured 2026-08-13** against a real page rendered at scale 2:

| | per page |
|---|---|
| input tokens | **25,518** |
| output tokens | 111 |
| cost | **$0.0039** |

That is **~7× a chat message per page**, so a 60-page document costs **~$0.23** — about
430 chat messages. This is the one operation where cost is genuinely material, and it
immediately invalidated the first draft of the quota limits: `ocr_page` had been seeded
at 300/**day** for STUDENT (misreading "300/month"), which at the measured rate is
**$35/month of worst-case spend against $9 of revenue**. Corrected to 60/day, so
worst-case monthly OCR stays under revenue on every paid tier.

**The shipped limit does NOT match this section's original intent — recorded rather
than quietly redefined.** This document said 300/**month** (≈ $1.17). The implemented
limit is 60/**day**, whose worst case is ≈ $7/month. Accepted, because per section 1
these quotas are abuse control rather than margin control: $7 from a genuinely heavy
human is tolerable, scripts are the actual threat, and a monthly window is a second
mechanism not worth building pre-beta. If OCR spend ever becomes material, add the
monthly window rather than tightening the daily cap further.

**Cheapest available optimisation — but do NOT take it without evidence.** Those 25.5k
input tokens come from rendering at `scale: 2`, and rendering smaller should cut cost
close to proportionally. The absolute saving is small (~$0.002/page) and extraction
quality is foundational: a degraded OCR pass silently poisons chunks, retrieval,
citations, and Exam Insights all at once, which costs far more than the tokens. Treat
render scale as an AI-surface change — build 3–5 scanned fixtures with known text,
compare accuracy at scale 1/1.5/2, and only flip with evidence. This is an argument for
Iteration B's gate, not for the tweak.

But cost is the weaker argument. **Ingestion is deliberately serialized** (agent
PR #16, to fix concurrent-upload failures — `enqueueIngest` is an in-process queue and
the agent cannot be scaled past one instance). So a single 500-page scanned PDF does
not merely cost money: **it blocks every other student's ingestion behind it.** During
finals that is an outage for everyone in exchange for one person's bad upload.

> **Action before launch:** meter OCR **pages**, not requests, and impose a hard
> per-upload page ceiling. This is queue protection first and spend control second.
> Measure cost/page as a one-off for the record, but the ceiling is justified without
> it.

### What actually costs money

Fixed platform cost, not usage: Neon, Railway (API + agent + the worker service),
Vercel, Sentry. That is a floor of tens of dollars a month whether we have 5 users
or 500. **Break-even is therefore a user-count problem, not a usage problem** — a
handful of subscribers covers infrastructure, and every one after that is nearly
pure margin.

---

## 2. What we are actually selling

Not "AI homework help." That is commodity, priced at zero by ChatGPT's free tier,
and we cannot win on it.

We sell **the answer being traceable to your class**: citations into your own
uploads, and what your specific professor has historically tested. That is the only
thing a general chatbot structurally cannot do.

Pricing must therefore put *grounded, course-scoped* work behind the wall and leave
*ungrounded* work free. That is the same line the product already draws honestly in
the UI ("this came from general knowledge — not your class"), which means the
paywall reinforces the product's argument instead of fighting it.

---

## 3. Tiers

| | **Free** | **Student — $9/mo** | **Quarter Pass — $19** |
|---|---|---|---|
| Quick Help (ungrounded) | 10 / day | unlimited¹ | unlimited¹ |
| Course chat (grounded, cited) | 5 / day | unlimited¹ | unlimited¹ |
| Uploads | 5 documents | 100 documents | 100 documents |
| OCR pages | 20 / month | 300 / month | 300 / month |
| Exam insights | view only, 1 course | all enrolled courses | all enrolled courses |
| Study guides | — | 20 / month | 20 / month |
| Advanced reasoning escalation | — | 10 / month | 30 / quarter |

¹ "Unlimited" means no product-facing cap, with a high abuse ceiling behind it. Given
$0.0005 per message, a genuinely heavy human cannot cost us meaningfully; only a
script can.

### Why $9

Chegg is ~$15.95, Course Hero ~$9.95+, ChatGPT Plus $20. We are **not** a ChatGPT
replacement and should not price like one — a student may well pay for both. $9
positions us as the cheaper, additive purchase and sits under the psychological $10
line. We have the margin to be aggressive here; use it to win the market rather than
to extract early.

### Why a Quarter Pass, and why the first price I wrote was wrong

Student willingness to pay is **not uniform across the year** — it spikes in the two
weeks before midterms and finals, which is exactly when exam insights is most
valuable. A monthly subscription invites subscribe-then-cancel around each exam,
which is expensive to manage and depresses LTV.

**Correction to my first draft:** I priced a "term pass" at $25 against three months
of monthly ($27). That is wrong for our beta campus. **UCSD is on quarters — about 10
weeks** — so $25 competes with roughly $22.50 of monthly and is a *worse* deal, which
destroys the entire reason to offer it.

Repriced: **$19/quarter** (vs ~$22.50 monthly), or **$45/academic year** (vs ~$67.50).
Both are now genuinely cheaper for the student and better for us: cash up front and no
mid-quarter churn decision.

**Check the term length of any campus we expand to** — semester schools are ~15 weeks
and the same price would be a giveaway.

**Recommend making the quarter pass the visually default option.**

### What is deliberately NOT limited

Reading your own past conversations and materials. Locking a student out of work
they already did would be hostile, and it is free for us to serve.

---

## 4. Model choice

The proposal was to let users pick the model. I think the instinct is right and the
framing is wrong, in three ways.

**Students do not know what to pick.** "gpt-4o-mini vs gpt-4o vs o3" is a developer's
vocabulary. Most will either ignore the setting or pick the biggest number and blame
us when it is slower.

**It mostly does not improve the thing we are good at — but there is one real
exception, and it produces a better feature.** Our value comes from retrieval and
citation quality; a stronger model does not retrieve better chunks, it writes more
fluently about whatever it was given.

**Correction to my first draft:** that is true for fluency and false for **multi-step
arithmetic correctness**, which is the one failure mode that can actually hurt a
student — a confidently wrong derivation is worse than no answer. So model strength
*does* matter, but only on a subset of questions we can identify.

**It breaks cost predictability and evaluation.** gpt-4o input is roughly 17× 4o-mini.
And the eval gate planned in Batch 4 has to pass *per model*, so every exposed model
multiplies the quality surface we are accountable for.

### Recommended instead — three separate mechanisms

**a) VERIFICATION-TRIGGERED escalation — automatic in offer, manual in trigger.**

We already compute the signal for this and currently throw it away: `verify.ts`
numerically checks a computable claim, and the UI only surfaces a badge when a check
*passes*. When verification **fails**, or the answer `looksComputational` and no check
passed, offer the escalation at that exact moment:

> "We couldn't verify the arithmetic in this answer. Re-run with deeper reasoning?
> (3 left this month)"

This is strictly better than a bare "think harder" button:
- it is sold at the honest moment, on the answers that genuinely need it, rather than
  asking the student to guess when a model is failing them;
- it uses a signal no competitor has wired up;
- it converts our own uncertainty into a **trust event** instead of a hidden risk —
  which is the same principle as labelling ungrounded answers.

Bounded by a counted allowance per tier, with the count shown in the button.

**b) Bring your own key — DEFERRED past beta, possibly permanently.**

I originally recommended this as a strong second. **Withdrawn.** Storing a student's
OpenAI key means a database compromise becomes *their* financial loss, in a project
that has already had one credential-exposure incident. And the justification was
operating cost — which section 1 shows is a rounding error, so we would be taking on
custody of other people's money-spending credentials to save cents.

For a student product this is probably a "no" rather than a "later".

**c) An allowlisted model picker in Settings, paid tiers only.** If we want explicit
choice, keep it to 2–3 vetted options with plain-language labels ("Faster" /
"Deeper reasoning"), not raw model IDs, and hold each to the same eval bar.

Do (a) first. It captures the revenue idea with the least surface area. (b) is a
strong second because it is nearly free to operate. (c) is optional.

---

## 5. The strategic lever nobody is pricing yet

The binding constraint on our differentiator is **corpus**, not compute. MATH 20C
currently has 4 assessment documents and 16 chunks of assessment material. Exam
insights works, and it is thin — because there is little to analyse.

So the most valuable thing a user can give us is not $9. It is **a past exam for a
professor we have nothing on.** That is what makes the product better for every
subsequent student in that class, and it is the only asset a competitor cannot buy.

### During beta: ship the ASK, not the bounty

**Correction to my first draft**, which proposed earning subscription time for
uploads. Paying for uploads before a moderation gate exists creates precisely the F10
poisoning scenario (a folder of Math170A files labelled Math109A). Do not pay for
content we cannot yet verify.

**Ship the free version now:** make the corpus visible and ask plainly.

> "MATH 20C has 4 past assessments. Add one and everyone in your class gets better
> answers."

Costs nothing, tests whether the behaviour happens at all, and produces the data to
decide whether a bounty is even needed. Students already share exam material
informally; the goal is to be where it lands.

**Two cautions to bank, not debate, before any bounty:**
1. *Incentivized* upload of professors' non-redistributable exams changes our legal
   posture — unpaid sharing by students is a different thing from us paying for it.
2. It changes our standing on campus. Being seen as buying exam material is not a
   recoverable reputation with faculty.

Ship the moderation gate first, then revisit.

---

## 6. Free tier abuse — the real risk

With inference at $0.0005/message, the threat is not a heavy student. It is:

- a script hitting Quick Help in a loop (authenticated, but sign-up is cheap)
- someone uploading a 500-page scanned PDF (OCR, the unmeasured cost)
- account farming to reset daily quotas

Mitigations, in priority order:

1. **Meter OCR pages, not just requests.** The only place a single action can cost
   real money.
2. **Per-day quotas keyed on user, enforced server-side before the model call** —
   i.e. before `writeHead` on the SSE routes, or the response has already started.
3. **A documented kill switch** per operation kind, settable without a deploy.
4. Rate limit sign-ups per IP. Cheap, and it is the actual account-farming control.

### One design point I want to flag on the quota plan

The plan says usage tracking should be authoritative and **deny on database
failure**. That is correct for a spend ceiling and wrong as a blanket rule: it means
a Neon blip takes tutoring down entirely for everyone.

Distinguish *"quota exceeded"* (deny, 429, tier in the payload) from *"quota system
unavailable"*. Conflating them makes an outage indistinguishable from a paywall, both
to the student and in our own metrics.

**Correction to my first draft:** I proposed making the failure mode
*per-environment*. The right axis is **per-operation cost-boundedness**, which ties
the behaviour to the actual risk rather than to which env file you happen to be in:

| operation | on quota-system failure | why |
|---|---|---|
| OCR, upload | **deny** | a single action is unbounded — pages, queue time, spend |
| chat, quick help, insights | **allow + loud alarm** | a single action is $0.0005 |

**Scope correction, found by testing it.** The intended story was that a database blip
degrades to *"tutoring still works, large uploads pause"*. Against a genuinely
unreachable database that is FALSE: `requireAuth` itself queries the database (the Clerk
path runs `SELECT id FROM users WHERE clerk_id=$1`), so every authenticated request 500s
in auth and the quota policy is never consulted.

The per-operation fail policy therefore covers failures **isolated to the quota layer** —
a statement timeout on the usage upsert, lock contention on `user_daily_usage`, a missing
`plan_limits` row, a bad migration. Those are real and more common than a total outage,
and the policy is tested against exactly that.

Making the original claim true needs auth to survive a brief outage (an in-memory
`clerk_id` → `user_id` cache). Worth doing; not pretended in the meantime.

**Fail-open must stay observable.** Graceful degradation masks defects — a parameter
type-deduction bug in the usage SQL was invisible precisely because allow-policy kinds
fell through to fail-open and kept serving traffic. Fail-open is now reported to Sentry
explicitly (console.error alone never reached it: there is no
`captureConsoleIntegration`) under a fixed fingerprint, so an alert can fire on any
nonzero event RATE rather than only on a novel issue.

> **User action:** add a Sentry alert on the issue fingerprinted
> `quota-system-unavailable` at any nonzero rate. Sentry's legacy issue-alert REST API
> returns 410, so this is a dashboard change.

---

## 7. Sequencing — Stripe is DEFERRED past launch

**Reversal, justified by section 1.** Payment integration was originally sequenced
before launch. It should not be: inference is ~1% of revenue, quotas are abuse control
rather than margin control, and **we are not charging during beta**. That makes ~2.5
days of Stripe work pure pre-launch drag with zero beta value. Build it *during* beta,
informed by real willingness-to-pay signals from the upgrade surfaces.

| | work | why now |
|---|---|---|
| **A** | Quotas + OCR page metering | the last functional launch blocker |
| **B** | Eval gate + coverage for quick-help and exam-insights | largest quality gap; escalation adds a second model to the matrix |
| **C** | Content + quality bar (3–5 seeded courses, human-review 20 answers) | thin corpus is the real product risk |
| **D** | Verification-triggered escalation (after B) | the one paid-tier feature worth having *before* payments, because it is how we learn whether anyone wants it |

Then launch. Stripe, BYOK (or not), and the corpus bounty are all beta-period work.

## 8. Three measurements that should precede three decisions

The most useful thing about this document was measuring instead of assuming — it
produced a conclusion that changed the plan. Three more measurements, each of which
could change a decision we would otherwise make on instinct:

1. **OCR cost per page** — a one-off. Recorded here when known.
2. **Messages per homework session** — set the free grounded cap near **p75 of a real
   session** rather than guessing 5. A cap below the median session length means the
   free tier cannot demonstrate the product at all, which defeats its purpose.
3. **Does escalation actually improve the answers it is offered on?** If a stronger
   model does not fix the arithmetic that failed verification, the feature is theatre
   and should not be sold.

## 9. Open questions

- **Do we charge during beta at all?** No. Charging while the corpus is thin sells a
  promise we cannot keep.
- **What do beta users get afterwards?** Recommend **6 months of Student tier free**,
  asked for in exchange for a testimonial. Cheap (section 1), and it converts goodwill
  into the social proof a student product actually needs.
- Free-tier caps: see measurement 2 — do not guess.
- Refund policy for a quarter pass bought two weeks before the quarter ends?
- Does a school or department ever become the buyer instead of the student? Much
  larger contract, entirely different surface (rosters, SSO, LMS) — worth knowing
  whether that is the ambition before building consumer billing.
