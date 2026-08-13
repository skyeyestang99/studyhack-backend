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

**About fourteen cents.** On a $15 subscription that is ~1% of revenue.

Two consequences:

1. **Do not price to cover marginal AI cost.** Price for value. The margin is
   already there; the risk is elsewhere.
2. **Quotas are an abuse and blast-radius control, not a margin control.** That
   changes how generous the free tier can be, and it means a quota breach should
   read as "something is wrong" rather than "a user is costing us money."

### The one cost we have NOT measured

**OCR.** It is a vision call per page, and it is the only operation whose cost is
plausibly 100× a chat message. A 40-page scanned exam could cost more than a
student's entire month of chatting. Nothing currently meters it.

> **Action before launch:** instrument actual OCR spend per page and put pages —
> not requests — on a quota. This is the single largest unknown in this document and
> the only one that could invert the economics above.

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

| | **Free** | **Student — $9/mo** | **Term Pass — $25 / term** |
|---|---|---|---|
| Quick Help (ungrounded) | 10 / day | unlimited¹ | unlimited¹ |
| Course chat (grounded, cited) | 5 / day | unlimited¹ | unlimited¹ |
| Uploads | 5 documents | 100 documents | 100 documents |
| OCR pages | 20 / month | 300 / month | 300 / month |
| Exam insights | view only, 1 course | all enrolled courses | all enrolled courses |
| Study guides | — | 20 / month | 20 / month |
| Advanced reasoning escalation | — | 10 / month | 30 / term |

¹ "Unlimited" means no product-facing cap, with a high abuse ceiling behind it. Given
$0.0005 per message, a genuinely heavy human cannot cost us meaningfully; only a
script can.

### Why $9

Chegg is ~$15.95, Course Hero ~$9.95+, ChatGPT Plus $20. We are **not** a ChatGPT
replacement and should not price like one — a student may well pay for both. $9
positions us as the cheaper, additive purchase and sits under the psychological $10
line. We have the margin to be aggressive here; use it to win the market rather than
to extract early.

### Why a Term Pass, and why it may matter more than the monthly

Student willingness to pay is **not uniform across the year** — it spikes in the two
weeks before midterms and finals, which is exactly when exam insights is most
valuable. A monthly subscription invites subscribe-then-cancel around each exam,
which is expensive to manage and depresses LTV.

A term pass priced at less than three months of monthly (25 vs 27) is the better
deal for the student *and* the better deal for us: cash up front, no mid-term churn
decision, and it naturally matches an academic calendar. **Recommend making the term
pass the visually default option.**

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

**It does not improve the thing we are good at.** Our value comes from retrieval and
citation quality. A stronger model does not retrieve better chunks; it writes more
fluently about whatever it was given. The model is rarely the bottleneck on answer
quality here — the corpus is.

**It breaks cost predictability and evaluation.** gpt-4o input is roughly 17× 4o-mini.
And the eval gate planned in Batch 4 has to pass *per model*, so every exposed model
multiplies the quality surface we are accountable for.

### Recommended instead — three separate mechanisms

**a) "Think harder" escalation (the monetizable one).** A per-message button that
re-runs the answer on a stronger model. Comprehensible ("this answer wasn't good
enough — try harder"), bounded (a counted allowance per tier), and it sells itself at
the moment of dissatisfaction rather than in a settings page. Internally this is
model choice; externally it is an outcome.

**b) Bring your own key (the escape valve).** Let a power user paste their own OpenAI
key and pick any model they like. This is where literal model selection genuinely
belongs: someone who has an API key already knows what the names mean. It removes our
inference cost entirely for our heaviest users, and it converts a support liability
into their own responsibility.
*Requires:* encrypted at rest, never logged, never used for anyone else's requests,
one-click removal, and a clear statement that their key pays for their usage.

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

**Recommend pricing that explicitly buys corpus:**

- Uploading a past exam/quiz for a course that has fewer than 3 assessments earns a
  **free week** of Student tier (cap it, and require the upload to pass ingestion —
  i.e. real extractable content, which migration 0021's constraints already enforce).
- Show the counterfactual plainly: "MATH 20C has 4 past assessments. Add one and
  everyone in your class gets better answers." Students already share exam material
  informally; make us the place it lands.

This inverts the usual cold-start problem: the people most motivated to contribute
are the ones who most want the feature to be good.

**Caveat to resolve before shipping this:** it creates an incentive to upload
*anything*, and the poisoning fixture already in the spec (F10 — a folder of
Math170A files labelled Math109A) shows how easily the wrong material lands in the
wrong course. Reward must be contingent on a moderation or verification gate, which
does not exist yet. **Do not ship the incentive before the gate.**

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

Recommend the failure mode be **explicit and per-environment**: distinguish
*"quota exceeded"* (deny, 429, with the tier in the payload) from *"quota system
unavailable"* (configurable — deny in production, allow-with-loud-alarm in perf).
Conflating the two makes an outage indistinguishable from a paywall, both to the
student and in our own metrics.

---

## 7. Sequencing

1. **Measure OCR cost per page.** Everything above is a guess until this is real.
2. Quotas (Batch 2) — abuse control, tier-aware from day one so pricing changes need
   no deploy.
3. Membership (Batch 3) — Stripe test mode, everyone on BETA, no charging yet.
4. "Think harder" escalation — the first genuine upsell, and the cheapest to build
   once quotas exist.
5. Corpus incentive — **only after** a moderation gate exists.
6. BYOK — whenever a user asks for it. Nearly free to operate.

## 8. Open questions

- **Do we charge during beta at all?** Recommend no: charging while the corpus is
  thin sells a promise we cannot yet keep. Collect payment details on nothing, or
  simply run everyone on BETA and price at the term boundary.
- Refund policy for a term pass bought two weeks before the term ends?
- Does a school or department ever become the buyer instead of the student? Much
  larger contract, entirely different product surface (rosters, SSO, LMS) — worth
  knowing whether that is the ambition before we build consumer billing.
- Is $9 leaving money on the table for students who would pay $15 in exam week?
  A/B the term pass price before the monthly.
