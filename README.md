# CoC Registration & Group Assignment System

This repository documents the frontend, backend, and admin automation used to manage **CoC (Circle of Connection)** study group registrations and assignments.

The system is intentionally simple, sheet-driven, auditable, and friendly to both humans and LLMs (Copilot, Cursor, ChatGPT, etc.).

---

## 1. System Overview

The system has **two major functional areas**:

1. **User Registration Form** (public-facing)
2. **Group Assignment & Admin Operations** (internal, Google Sheets–driven)

Each area is independent but connected through a shared data contract.

---

## 2. Technology Stack

| Layer | Technology |
|----|----|
Frontend | Static HTML + Vanilla JavaScript |
Backend | Google Apps Script (Web App – `doPost`) |
Storage | Google Sheets |
Security | reCAPTCHA v3 + Honeypot |
Hosting | GitHub Pages / Google Sites |
Admin UI | Google Sheets |

---

## 3. Canonical Concepts (Important)

### 3.1 Supported Languages (Canonical Encoding)

All systems use **full language names**, not codes:
# CoC Registration & Group Assignment System

This repository documents the frontend, backend, and admin automation used to manage **CoC (Circle of Connection)** study group registrations and assignments.

The system is intentionally simple, sheet-driven, auditable, and friendly to both humans and LLMs (Copilot, Cursor, ChatGPT, etc.).

---

## 1. System Overview

The system has **two major functional areas**:

1. **User Registration Form** (public-facing)
2. **Group Assignment & Admin Operations** (internal, Google Sheets–driven)

Each area is independent but connected through a shared data contract.

---

## 2. Technology Stack

| Layer | Technology |
|----|----|
Frontend | Static HTML + Vanilla JavaScript |
Backend | Google Apps Script (Web App – `doPost`) |
Storage | Google Sheets |
Security | reCAPTCHA v3 + Honeypot |
Hosting | GitHub Pages / Google Sites |
Admin UI | Google Sheets |

---

## 3. Canonical Concepts (Important)

### 3.1 Supported Languages (Canonical Encoding)

All systems use **full language names**, not codes:
# CoC Registration & Group Assignment System

This repository documents the frontend, backend, and admin automation used to manage **CoC (Circle of Connection)** study group registrations and assignments.

The system is intentionally simple, sheet-driven, auditable, and friendly to both humans and LLMs (Copilot, Cursor, ChatGPT, etc.).

---

## 1. System Overview

The system has **two major functional areas**:

1. **User Registration Form** (public-facing)
2. **Group Assignment & Admin Operations** (internal, Google Sheets–driven)

Each area is independent but connected through a shared data contract.

---

## 2. Technology Stack

| Layer | Technology |
|----|----|
Frontend | Static HTML + Vanilla JavaScript |
Backend | Google Apps Script (Web App – `doPost`) |
Storage | Google Sheets |
Security | reCAPTCHA v3 + Honeypot |
Hosting | GitHub Pages / Google Sites |
Admin UI | Google Sheets |

---

## 3. Canonical Concepts (Important)

### 3.1 Supported Languages (Canonical Encoding)

All systems use **full language names**, not codes:

English
Tamil
Hindi
Kannada
Telugu

> Display text may be localized, but submitted values are always canonical.

---

### 3.2 Preferred Time Slots (Canonical Encoding)

All time slots are stored as **opaque strings**:

<Day> Day
<Day> Evening

Examples:
Mon Day
Thu Evening
Sun Day


User-facing labels:
- Day (10am – 5pm)
- Evening (5pm – 10pm)

Admin and backend logic treats these as strings only.

---

## 4. User Registration Form

### 4.1 Purpose
Collect participant registrations securely, multilingual, and at scale.

---

### 4.2 Data Flow

User
→ HTML Form
→ fetch(FormData)
→ Apps Script doPost
→ Validation
→ Google Sheet (CustomForm)
→ Confirmation Email


---

### 4.3 Registration Fields (Contract)

| Field | Name | Required | Notes |
|----|----|----|----|
Email | `Email` | Yes | HTML + backend validated |
Name | `Name` | Yes | Free text |
WhatsApp | `WhatsApp` | Yes | Indian mobile regex |
Center | `Center` | Yes | Free text |
Language | `Language` | Yes | Canonical value |
English proficiency | `English` | Conditional | Required if Language ≠ English |
Preferred times | `Times` | Yes | Checkbox grid |
Coordinator willing | `Coordinator` | Yes | Yes / No |
Honeypot | `honey` | No | Must be empty |
Captcha token | `recaptcha` | Yes | Added programmatically |

---

### 4.4 Validation Model (Single Source of Truth)

All business rules live in the **backend**.

Rules:
- Required fields must be present
- WhatsApp must be valid Indian number
- At least one preferred time must be selected
- If Language ≠ English → English proficiency must be “Yes”
- If Language = English → backend auto-sets English proficiency to “Yes”

Frontend validation is **UX-only**, not authoritative.

---

### 4.5 Critical Frontend Rule (Must Not Be Broken)

> **Never disable inputs before creating `FormData`.**

Correct pattern:
```js
const fd = new FormData(form);
submitButton.disabled = true;
Disabled inputs are excluded from FormData.

4.6 Backend Response Contract

Success:
{ "result": "success" }

Validation error:
{
  "result": "error",
  "error": "Validation failed",
  "missing": ["Coordinator", "Preferred days & times"]
}
Frontend displays backend errors verbatim.
5. Admin Group Assignment System
5.1 Purpose

Assign registered participants into CoC groups using transparent, admin-controlled logic.

This is a Google Sheets–first workflow.

5.2 Core Sheets
Sheet	Role
CustomForm	Raw registrations (append-only)
Participants	Normalized participant records
Groups	Derived group definitions
Admin Dashboard	Read-only stats
5.3 Group Definition Rules

A valid group:

Same language

5–8 members (soft limits)

At least one common time slot

At least one coordinator-willing member

Prefer same center (soft constraint)

5.4 Group Naming Convention (Strict)

CoC-<Language>-<Sequence>
Examples:
CoC-English-001
CoC-Tamil-004
Sequence is per-language

New groups continue the highest existing sequence

5.5 Admin Workflows
Populate Participants
Pulls data from CustomForm

Assigns Participant IDs

No grouping performed

Suggest Groups
Menu/button-triggered

Suggests group names for unassigned participants

Does not auto-commit assignments

Assign Groups
Admin confirms group and coordinator in Participants sheet

Status updated to Assigned

Refresh Groups & Dashboard
Rebuilds Groups sheet

Recomputes member counts, coordinators

Updates dashboard stats (by language)

5.6 Coordinator Handling
Participants indicate willingness (Yes / No)

Admin explicitly designates the coordinator per group

System does not auto-pick coordinators

5.7 Time Slot Handling (Admin Logic)
Admin scripts:

Do not parse “Day / Evening”

Do not interpret semantics

Compare slots by string equality

This makes UI label changes safe.

6. Design Philosophy
Sheets are the UI

Apps Script enforces consistency

No background automation

All assignments are explicit admin actions

Dashboards are derived, never edited manually

Readability > cleverness

7. Current Status
Registration flow: ✅ stable

Backend validation: ✅ authoritative

Multilingual support: ✅ complete

Admin grouping: ✅ functional

Time slot consistency: ✅ aligned

8. Notes for LLMs / Contributors
When modifying this system:

Do not change field names lightly

Treat backend as the source of truth

Keep time slot values canonical

Avoid implicit frontend assumptions

Prefer explicit admin actions over automation

9. Future Enhancements (Out of Scope)
One-click accept group suggestions

Coordinator/member bulk email tools

Automated reassignment workflows

Permissioned admin access by language

