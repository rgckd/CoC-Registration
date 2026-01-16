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
| Frontend | Static HTML + Vanilla JavaScript |
| Backend | Google Apps Script (Web App – `doPost`) |
| Storage | Google Sheets |
| Security | reCAPTCHA v3 + Honeypot |
| Hosting | GitHub Pages / Google Sites |
| Admin UI | Google Sheets |

---

## 3. Sheet Column Mappings (Authoritative)

All code is **column-agnostic** using header-based lookup via `indexMap()`. This means:
- Column order doesn't matter
- Column names are the source of truth
- Code queries sheets by header name, not position

### 3.1 CustomForm Sheet Columns

| Column | Type | Notes |
|--------|------|-------|
| Timestamp | DateTime | Auto-generated submission time |
| Email | String | Participant email (required, unique) |
| Name | String | Full name (required) |
| WhatsApp | String | International number: 8–15 digits (required) |
| Center | String | Heartfulness center name (required) |
| EnglishProficiency | String | Yes/No or auto-filled based on language |
| PreferredTimes | String | Comma-separated day/time slots (e.g., "Mon Day, Tue Evening") |
| Coordinator | String | Yes/No indicating willingness to coordinate |
| Language | String | Full language name (required) |
| Processed | Boolean | Marks if the row has been transferred to Participants sheet |
| Comments | String | Optional comments from participant (last column) |

### 3.2 Participants Sheet Columns

| Column | Type | Notes |
|--------|------|-------|
| ParticipantID | String | Auto-generated ID (P-0001, P-0002, etc.) |
| Name | String | Normalized from CustomForm |
| Email | String | Unique identifier, from CustomForm |
| WhatsApp | String | From CustomForm |
| Language | String | Full language name |
| Center | String | From CustomForm |
| PreferredSlots | String | Time slots populated from CustomForm.PreferredTimes |
| CoordinatorWilling | Boolean | Populated from CustomForm.Coordinator |
| AssignedGroup | String | Final group name (e.g., CoC-English-001) |
| AssignmentStatus | String | Unassigned, Assigned, or custom status |
| IsGroupCoordinator | Boolean | Admin marks who leads the group |
| AcceptSuggestion | Boolean | Admin confirms suggested group |
| SuggestedGroup | String | System-generated group suggestion |
| Notes | String | Admin notes |
| IsActive | Boolean | Coordinator-updated participation flag |

### 3.3 Groups Sheet Columns

| Column | Type | Notes |
|--------|------|-------|
| GroupID | String | Unique opaque ID (e.g., G-0001) |
| GroupName | String | Formatted as CoC-<Language>-<Sequence> (e.g., CoC-English-001) |
| Language | String | Full language name |
| Day | String | Extracted from slot suggestions (e.g., Mon, Tue) |
| Time | String | Day or Evening |
| CoordinatorEmail | String | Populated from Participants when admin assigns coordinator |
| CoordinatorName | String | Populated from Participants when admin assigns coordinator |
| CoordinatorWhatsApp | String | Populated from Participants when admin assigns coordinator |
| MemberCount | Number | Auto-computed by refresh |
| Status | String | Active, Inactive, etc. |
| Sequence | Number | Language-specific sequence number |
| WeeksCompleted | Number | Coordinator-updated weeks completed (0–20) |
| Notes | String | Coordinator notes |
| LastUpdated | Timestamp | Auto-recorded when coordinator updates group status |

### 3.4 AdminDashboard Sheet Columns

| Column | Type | Notes |
|--------|------|-------|
| DashboardSection | String | Section grouping (Groups, Participants) |
| Metric | String | Label of metric (e.g., "Active Groups", "Unassigned Participants") |
| English | Number | Count for English language |
| Tamil | Number | Count for Tamil language |
| Hindi | Number | Count for Hindi language |
| Kannada | Number | Count for Kannada language |
| Telugu | Number | Count for Telugu language |

**Dashboard Layout:**

The dashboard is completely reconstructed each time it refreshes. Column headers are in gray, followed by two visually distinct sections: GROUPS and PARTICIPANTS with darker section headers. Action items use a very light red tint and only highlight the metric label plus the language cells that are non-zero.

*Groups section:*
- Active Groups
- Inactive Groups ⚠️ (highlighted for action)
- Completed Groups
- Closed Groups
- Terminated Groups
- Groups without Coordinator ⚠️ (highlighted for action)

*Participants section:*
- Unassigned Participants
- Assigned Participants
- Inactive Participants ⚠️ (highlighted for action)
- Discontinued Participants
- Completed Participants

⚠️ Highlighted metrics indicate action items requiring admin attention. Only the metric label and non-zero language cells are tinted; zero-value cells remain unhighlighted. The DashboardSection column shows the section name only in section headers, not repeated in data rows. All values are auto-computed by `updateAdminDashboard()` and the sheet is completely cleared and rebuilt each time the dashboard is refreshed.

---

## 4. Canonical Concepts (Important)

### 4.1 Supported Languages (Canonical Encoding)

All systems use **full language names**, not codes:
- English
- Tamil
- Hindi
- Kannada
- Telugu

> Display text may be localized, but submitted values are always canonical.

---

### 4.2 Preferred Time Slots (Canonical Encoding)

All time slots are stored as **opaque strings**:

Format: `<Day> <Time>`

Examples:
- Mon Day
- Tue Evening
- Thu Day
- Sun Evening

User-facing labels:
- **Day**: 10am – 5pm
- **Evening**: 5pm – 10pm

**Admin and backend logic treats these as strings only** — no parsing of Day/Evening semantics.

---

## 5. User Registration Form

### 5.1 Purpose
Collect participant registrations securely, multilingual, and at scale.

---

### 5.2 Data Flow

```
User
  ↓
HTML Form (index.html)
  ↓
fetch(FormData) + reCAPTCHA
  ↓
Apps Script doPost
  ↓
Validation (backend authoritative)
  ↓
Google Sheet (CustomForm) - append-only
  ↓
Confirmation Email (includes all fields + English proficiency for non-English + comments if provided)
```

---

### 5.3 Registration Fields (Data Contract)

| Field | Form Name | Required | Notes |
|-------|-----------|----------|-------|
| Email | `Email` | Yes | HTML + backend validated |
| Name | `Name` | Yes | Free text |
| WhatsApp | `WhatsApp` | Yes | International number: 8–15 digits (include country code) |
| Center | `Center` | Yes | Free text |
| Language | `Language` | Yes | Canonical value (select dropdown) |
| English proficiency | `EnglishAbility` | Conditional | Required if Language ≠ English |
| Preferred times | `Times` | Yes | Checkbox grid |
| Coordinator willing | `Coordinator` | Yes | Yes / No (select dropdown) |
| Comments | `Comments` | No | Optional free text (label: "Comments (if any)", not translated) |
| Honeypot | `honey` | No | Must be empty (spam trap) |
| Captcha token | `recaptcha` | Yes | Added programmatically by form |

---

### 5.4 Validation Model (Single Source of Truth)

**All business rules live in the backend** (CoC Reg Form.gs).

Rules:
- Required fields must be present
- WhatsApp must be 8–15 digits after stripping symbols (include country code)
- At least one preferred time must be selected
- If Language ≠ English → `EnglishAbility` must be "Yes"
- If Language = English → backend auto-sets `EnglishAbility` to "Yes"

Frontend validation is **UX-only**, not authoritative.

---

### 5.5 Critical Frontend Rule (Must Not Be Broken)

> **Never disable inputs before creating `FormData`.**

Correct pattern:
```js
const fd = new FormData(form);
submitButton.disabled = true;
```

❌ Wrong:
```js
submitButton.disabled = true;  // Too early!
const fd = new FormData(form);  // Disabled inputs excluded
```

---

### 5.6 Backend Response Contract

**Success:**
```json
{ "result": "success" }
```

**Validation error:**
```json
{
  "result": "error",
  "error": "Missing required field(s)",
  "missing": ["Coordinator", "Preferred days & times"]
}
```

Frontend displays backend errors verbatim.

---

## 6. Admin Group Assignment System

### 6.1 Purpose

Assign registered participants into CoC groups using transparent, admin-controlled logic.

This is a **Google Sheets–first workflow**. No background automation or implicit decisions.

---

### 6.2 Core Sheets

| Sheet | Role |
|-------|------|
| CustomForm | Raw registrations (append-only) |
| Participants | Normalized participant records with assignment state |
| Groups | Derived group definitions |
| AdminDashboard | Read-only stats (auto-computed) |

---

### 6.3 Group Definition Rules

A valid group must have:

1. **Same language** (required)
2. **5–8 members** (soft limits)
3. **At least one common time slot** (required)
4. **At least one coordinator-willing member** (required)
5. **Prefer same center** (soft constraint, not enforced)

---

### 6.4 Group Naming Convention (Strict)

Format: `CoC-<Language>-<Sequence>`

Examples:
- CoC-English-001
- CoC-Tamil-004
- CoC-Hindi-002

**Sequence is per-language and count-based.** The sequence number is determined by counting existing groups for that language and adding 1. For example, if there are 4 Tamil groups, the next suggested group will be `CoC-Tamil-005`.

---

### 6.5 Admin Workflows

#### Populate Participants
- Triggered by menu: "Populate Participants (All Languages)"
- Pulls data from CustomForm
- Assigns Participant IDs (P-0001, P-0002, etc.)
- No grouping performed
- Only new emails are added (no duplicates)

#### Suggest Groups
- Triggered by language-specific menu items
- Suggests **NEW group names only** for unassigned participants
- Does **not** assign participants to existing groups
- Each participant gets a unique new group suggestion based on their first preferred time slot
- Does **not** auto-commit assignments
- Suggestions appear in SuggestedGroup column with format: `NEW → CoC-{Language}-{Seq} ({TimeSlot})`
- Admin reviews and checks AcceptSuggestion checkbox to confirm

#### Accept Group Suggestions
- Processes all rows with AcceptSuggestion = true
- **Pattern matching for group assignments:**
  - **Pattern a** (`NEW → CoC-{Language}-{Seq} ({TimeSlot})`): Creates new group with specified timing
  - **Pattern b** (`CoC-{Language}-{Seq}`): Reassigns to existing group
- Creates new groups in Groups sheet if needed
  - Extracts Day & Time from timing slot (or sets to "TBD")
  - Auto-populates coordinator info if IsGroupCoordinator is set for any member
- Updates Participants with AssignedGroup and AssignmentStatus
- **Sends assignment emails:**
  - **For group members**: Group info + coordinator contact details
  - **For coordinators**: Group info + full member list with contact details
  - All emails sent in participant's selected language
- Does not auto-pick coordinators (admin must set IsGroupCoordinator before accepting suggestions)

#### Refresh Groups & Dashboard
- Rebuilds Groups sheet from Participants data
- Auto-creates any groups referenced in Participants but missing from Groups sheet
- Recomputes MemberCount, CoordinatorEmail, CoordinatorName, CoordinatorWhatsApp
- Updates AdminDashboard stats (by language)

---

### 6.6 Coordinator Handling

1. **Participants indicate willingness** → CustomForm.Coordinator = Yes/No
2. **System populates** → Participants.CoordinatorWilling
3. **Admin explicitly designates** → Participants.IsGroupCoordinator = true
4. **System derives** → Groups.CoordinatorEmail, CoordinatorName, CoordinatorWhatsApp
5. **Email notifications** → Sent automatically when accepting group suggestions

System does **not** auto-pick coordinators.

---

### 6.7 Time Slot Handling (Admin Logic)

Admin scripts:
- Do **not** parse "Day / Evening"
- Do **not** interpret semantics
- Compare slots by **string equality**

This makes UI label changes safe. If you change the UI label from "Day" to "Morning", only the UI changes — the canonical slot value "Mon Day" remains in the system.

---

### 6.8 Groups Lifecycle

Groups can move through the following statuses (`Groups.Status`):
- **Active**: All groups start as Active at creation. Active groups are visible in the Coordinator update form. Participants under an Active group may be Active or Inactive (`IsActive = TRUE/FALSE`).
- **Inactive**: Coordinators mark their groups Inactive via the update form when the group is no longer meeting. Inactive groups remain visible in the Coordinator update form. A weekly job will later mark these as Terminated (see below).
- **Completed**: Coordinators mark groups as Completed when they finish all 20 weekly sessions. Completed groups remain visible in the Coordinator update form until the weekly job closes them.
- **Closed**: A weekly batch job marks all Completed groups as Closed, sends emails to participants and coordinators, and updates participants to `AssignmentStatus = Completed` and `IsActive = FALSE`. Closed groups are not shown in the Coordinator update form.
- **Terminated**: A weekly batch job marks all Inactive groups as Terminated, sends emails to participants and coordinators, and updates participants to `AssignmentStatus = Discontinued` and `IsActive = FALSE`. Terminated groups are not shown in the Coordinator update form.

Weekly lifecycle processing also sends a summary email to each language admin with the status changes applied that week.

Setup note:
- To include the CoC Master sheet link in the weekly summary email, set the script property `MASTER_SHEET_URL` (Apps Script → Project Settings → Script Properties).

### 6.9 Participants / Coordinator Lifecycle

Participants (including coordinators) have two independent fields:
- **Activity**: `IsActive = TRUE/FALSE`
- **AssignmentStatus**: `Unassigned`, `Assigned`, `Reassign` (external), plus new `Discontinued`, `Completed`

Lifecycle rules:
- **Active**: Participants are added as Active on registration. Coordinators may mark a participant Inactive via the update form.
- **Inactive**: Indicates the participant is not joining sessions. Coordinators set `IsActive = FALSE`.
- **Assigned**: Set when a participant is added to a group. Independent of activity flag.
- **Unassigned**: Default upon registration.
- **Reassign**: For participants wanting to change groups (process handled outside the system).
- **Discontinued**: Weekly job sets participants to Discontinued and `IsActive = FALSE` when their group is Terminated. Additionally, the weekly job identifies Inactive participants (`IsActive = FALSE`) under Active groups, sets their status to Discontinued, and sends them an email.
- **Completed**: Weekly job sets participants to Completed when their group is Closed.

Re-registration link (emails reference): https://www.hcessentials.org/coc-registration-form

Coordinator UI behavior:
- Hides groups in `Closed` and `Terminated` status
- Hides participants with `AssignmentStatus = Discontinued`

---

## 7. Design Philosophy

- **Sheets are the UI** – no separate admin dashboard or CRM
- **Apps Script enforces consistency** – validates, normalizes, derives
- **No background automation** – all grouping is explicit admin action
- **All assignments are explicit** – no auto-assignment or AI-driven decisions
- **Dashboards are derived, never edited manually** – read-only, auto-computed
- **Readability > cleverness** – prefer simple loops over clever JS

---

## 8. Daily Alert Automation

The system includes an optional daily batch processing function that:
1. Processes new registrations from CustomForm to Participants
2. Identifies unassigned participants by language
3. Sends alert emails to language admins

### Setup Instructions

1. **Configure Script Properties** (Apps Script Editor → Project Settings → Script Properties):
   - `ADMIN_EMAIL_ENGLISH` – Email for English admin
   - `ADMIN_EMAIL_TAMIL` – Email for Tamil admin
   - `ADMIN_EMAIL_HINDI` – Email for Hindi admin
   - `ADMIN_EMAIL_KANNADA` – Email for Kannada admin
   - `ADMIN_EMAIL_TELUGU` – Email for Telugu admin

2. **Set up Time-Based Trigger** (Apps Script Editor → Triggers):
   - Function: `dailyParticipantProcessingWithAlerts`
   - Event source: Time-driven
   - Type: Day timer
   - Time of day: Choose preferred time (e.g., 9am to 10am)

### Alert Email Contents

Each language admin receives an email when there are new unassigned participants:
- Subject: `CoC New Registrations Alert - [Language]`
- Participant details table (ID, Name, Email, WhatsApp, Preferred Slots, Willing to Coordinate)
- Link to CoC Registrations spreadsheet: https://docs.google.com/spreadsheets/d/1aBJ8vJx5UHrnPEsNZ-y_REVv6F7F_sYjXPJoCw2AxvU/edit?usp=sharing

---

## 9. Current Status

| Feature | Status |
|---------|--------|
| Registration form | ✅ stable |
| Backend validation | ✅ authoritative |
| Multilingual support | ✅ complete |
| Admin grouping | ✅ functional |
| Time slot consistency | ✅ aligned |
| Column-agnostic code | ✅ refactored |

---

## 10. Notes for LLMs / Contributors

When modifying this system:

1. **Do not change field/column names lightly** – They are the API contract between systems
2. **Treat backend as the source of truth** – Frontend validation is UX only
3. **Keep time slot values canonical** – Always use "Day" / "Evening", never localized
4. **Avoid implicit frontend assumptions** – Validate on backend always
5. **Prefer explicit admin actions over automation** – Let humans decide group assignments
6. **Use `indexMap()` for column lookups** – Never hardcode column positions
7. **Log changes** – Sheet-driven audits require traceability

---

## 11. Future Enhancements (Out of Scope)

- One-click accept group suggestions
- Coordinator/member bulk email tools
- Automated reassignment workflows
- Permissioned admin access by language
- Mobile-friendly admin interface

