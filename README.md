# Service Escrow Workflow

Service marketplace escrow workflow — vendor delivery, revision cycles, payment capture, and refunds with NestJS + Stripe.

## Flow

`IN_PROGRESS → SUBMITTED → REVISION_REQUESTED → COMPLETED` (+ refund path)

1. Payment authorized (held)
2. Vendor submits work
3. Client accepts, requests revision, or refunds after a revision cycle
4. On accept: capture payment
5. Auto-accept after N days if no client action

## Stack

- NestJS
- Prisma / PostgreSQL
- Stripe (authorize / capture)

## Structure

- `src/work-orders` — submit, revise, accept, refund, auto-complete cron
- `src/payments` — Stripe payment intents / escrow helpers
- `src/mail` — notification email helper used by work orders
- `src/auth` — JWT guard used by work-order routes
- `frontend/components` — Stripe checkout UIs for escrow flows

## Setup

1. Copy `.env.example` to `.env` and fill Stripe test keys + `DATABASE_URL`
2. `npm install`
3. `npx prisma generate`
4. `npm run start:dev`

> Extracted from production marketplace work under NDA. Branding removed from this package metadata; rotate any keys if you ever used real credentials locally.
