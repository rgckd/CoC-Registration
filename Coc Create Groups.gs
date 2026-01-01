/************************************************
 * MENU
 ************************************************/
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("CoC Admin")
    .addItem("Populate Participants (All Languages)", "populateParticipantsFromCustomForm")
    .addSeparator()
    .addItem("Suggest Groups – English", "suggestGroupsEnglish")
    .addItem("Suggest Groups – Tamil", "suggestGroupsTamil")
    .addItem("Suggest Groups – Hindi", "suggestGroupsHindi")
    .addItem("Suggest Groups – Kannada", "suggestGroupsKannada")
    .addItem("Suggest Groups – Telugu", "suggestGroupsTelugu")
    .addSeparator()
    .addItem("Accept Group Suggestions", "acceptGroupSuggestions")
    .addSeparator()
    .addItem("Refresh Groups and Dashboard", "refreshGroupsAndDashboard")
    .addToUi();
}

/************************************************
 * MENU WRAPPERS (Apps Script requires these)
 ************************************************/
function suggestGroupsEnglish() { suggestGroupsForLanguage("English"); }
function suggestGroupsTamil() { suggestGroupsForLanguage("Tamil"); }
function suggestGroupsHindi() { suggestGroupsForLanguage("Hindi"); }
function suggestGroupsKannada() { suggestGroupsForLanguage("Kannada"); }
function suggestGroupsTelugu() { suggestGroupsForLanguage("Telugu"); }

/************************************************
 * POPULATE PARTICIPANTS FROM CustomForm
 ************************************************/
function populateParticipantsFromCustomForm() {
  const ss = SpreadsheetApp.getActive();
  const src = ss.getSheetByName("CustomForm");
  const tgt = ss.getSheetByName("Participants");

  const sData = src.getDataRange().getValues();
  const tData = tgt.getDataRange().getValues();

  const sHeaders = sData.shift();
  const tHeaders = tData.shift();

  const sIdx = indexMap(sHeaders);
  const tIdx = indexMap(tHeaders);

  const existingEmails = new Set(
    tData.map(r => r[tIdx.Email]).filter(Boolean)
  );

  let nextId = getNextParticipantIdStart(tgt, tIdx.ParticipantID);
  let rows = [];

  sData.forEach(r => {
    const email = r[sIdx.Email];
    if (!email || existingEmails.has(email)) return;

    rows.push([
      "P-" + String(nextId++).padStart(4, "0"), // ParticipantID
      r[sIdx.Name],
      email,
      r[sIdx.WhatsApp],
      normalizeLanguage(r[sIdx.Language]),
      r[sIdx.Center],
      r[sIdx.PreferredTimes],        // PreferredSlots in Participants
      r[sIdx.Coordinator] === "Yes", // CoordinatorWilling
      "",                             // AssignedGroup
      "Unassigned",
      false,                          // IsGroupCoordinator
      false,                          // AcceptSuggestion
      "",                             // SuggestedGroup
      ""                              // Notes
    ]);
  });

  if (rows.length) {
    tgt.getRange(tgt.getLastRow() + 1, 1, rows.length, rows[0].length)
      .setValues(rows);
  }
}

/************************************************
 * SUGGEST GROUPS (LANGUAGE SCOPED)
 ************************************************/
function suggestGroupsForLanguage(language) {
  const ss = SpreadsheetApp.getActive();
  const pSheet = ss.getSheetByName("Participants");
  const gSheet = ss.getSheetByName("Groups");

  const pData = pSheet.getDataRange().getValues();
  const gData = gSheet.getDataRange().getValues();

  const pHeaders = pData.shift();
  const gHeaders = gData.shift();

  const pIdx = indexMap(pHeaders);
  const gIdx = indexMap(gHeaders);

  const participants = pData
    .map((r, i) => ({ row: i + 2, data: r }))
    .filter(p =>
      p.data[pIdx.Language] === language &&
      p.data[pIdx.AssignmentStatus] === "Unassigned"
    );

  participants.forEach(p => {
    const slots = splitSlots(p.data[pIdx.PreferredSlots]);

    const match = gData.find(g =>
      g[gIdx.Language] === language &&
      g[gIdx.Status] === "Active" &&
      slots.includes(`${g[gIdx.Day]} ${g[gIdx.Time]}`)
    );

    if (match) {
      pSheet.getRange(p.row, pIdx.SuggestedGroup + 1)
        .setValue(match[gIdx.GroupName]);
    } else {
      const seq = getNextGroupSequence(gData, gIdx, language);
      pSheet.getRange(p.row, pIdx.SuggestedGroup + 1)
        .setValue(`NEW → CoC-${language}-${String(seq).padStart(3, "0")} (${slots[0] || "TBD"})`);
    }
  });
}

/************************************************
 * ACCEPT GROUP SUGGESTIONS
 * - Creates groups
 * - Assigns participants
 * - Computes member count & coordinator
 ************************************************/
function acceptGroupSuggestions() {
  const ss = SpreadsheetApp.getActive();
  const pSheet = ss.getSheetByName("Participants");
  const gSheet = ss.getSheetByName("Groups");

  const pData = pSheet.getDataRange().getValues();
  const gData = gSheet.getDataRange().getValues();

  const pHeaders = pData.shift();
  const gHeaders = gData.shift();

  const pIdx = indexMap(pHeaders);
  const gIdx = indexMap(gHeaders);

  pData.forEach((row, i) => {
    if (row[pIdx.AcceptSuggestion] !== true) return;
    if (!row[pIdx.SuggestedGroup]) return;

    const m = row[pIdx.SuggestedGroup].match(/CoC-[^-]+-\d{3}/);
    if (!m) return;

    const groupName = m[0];

    if (!gData.some(g => g[gIdx.GroupName] === groupName)) {
      const slot = (row[pIdx.SuggestedGroup].match(/\((.*?)\)/) || [])[1] || "TBD";
      const [day, time] = slot.split(" ");
      const seq = getNextGroupSequence(gData, gIdx, row[pIdx.Language]);

      gSheet.appendRow([
        groupName,              // A GroupName
        row[pIdx.Language],     // B Language
        day || "",              // C Day
        time || "",             // D Time
        row[pIdx.Center] || "", // E Center
        "",                     // F CoordinatorEmail
        "",                     // G CoordinatorName
        0,                      // H MemberCount
        "Active",               // I Status
        seq                     // J Sequence
      ]);

      gData.push([
        groupName,
        row[pIdx.Language],
        day || "",
        time || "",
        row[pIdx.Center] || "",
        "",
        "",
        0,
        "Active",
        seq
      ]);
    }

    row[pIdx.AssignedGroup] = groupName;
    row[pIdx.AssignmentStatus] = "Assigned";
    row[pIdx.SuggestedGroup] = "";
    row[pIdx.AcceptSuggestion] = false;
    pData[i] = row;
  });

  pSheet.getRange(2, 1, pData.length, pHeaders.length).setValues(pData);

  // Ensure data is written before refresh
  SpreadsheetApp.flush();

  // Immediately recompute derived data
  updateGroupsSheet();
  updateAdminDashboard();
}

/************************************************
 * REFRESH (DERIVED DATA)
 ************************************************/
function refreshGroupsAndDashboard() {
  updateGroupsSheet();
  updateAdminDashboard();
}

/************************************************
 * UPDATE GROUPS (DERIVED FIELDS ONLY)
 ************************************************/
function updateGroupsSheet() {
  const ss = SpreadsheetApp.getActive();
  const pSheet = ss.getSheetByName("Participants");
  const gSheet = ss.getSheetByName("Groups");

  const pData = pSheet.getDataRange().getValues();
  const gData = gSheet.getDataRange().getValues();

  if (gData.length < 2) return;

  const pHeaders = pData.shift();
  const gHeaders = gData.shift();

  const pIdx = indexMap(pHeaders);
  const gIdx = indexMap(gHeaders);

  const members = {};
  pData.forEach(r => {
    if (!r[pIdx.AssignedGroup]) return;

    if (!members[r[pIdx.AssignedGroup]]) {
      members[r[pIdx.AssignedGroup]] = [];
    }

    members[r[pIdx.AssignedGroup]].push(r);
  });


  gData.forEach(r => {
    const m = members[r[gIdx.GroupName]] || [];
    r[gIdx.MemberCount] = m.length;

    const c = m.find(x => x[pIdx.IsGroupCoordinator] === true);
    r[gIdx.CoordinatorName] = c ? c[pIdx.Name] : "";
    r[gIdx.CoordinatorEmail] = c ? c[pIdx.Email] : "";
  });

  gSheet.getRange(2, 1, gData.length, gHeaders.length).setValues(gData);
}

/************************************************
 * ADMIN DASHBOARD
 ************************************************/
function updateAdminDashboard() {
  const ss = SpreadsheetApp.getActive();
  const p = ss.getSheetByName("Participants").getDataRange().getValues();
  const g = ss.getSheetByName("Groups").getDataRange().getValues();
  const d = ss.getSheetByName("AdminDashboard");

  const pH = p.shift();
  const gH = g.shift();
  const pIdx = indexMap(pH);
  const gIdx = indexMap(gH);

  const langs = ["English", "Tamil", "Hindi", "Kannada", "Telugu"];
  const metrics = [
    { key: "Unassigned", label: "Unassigned Participants" },
    { key: "Assigned", label: "Assigned Participants" },
    { key: "TotalGroups", label: "Total Groups" },
    { key: "ActiveGroups", label: "Active Groups" },
    { key: "NoCoordinator", label: "Groups without Coordinator" }
  ];

  d.getRange(2, 1, 50, 10).clearContent();

  metrics.forEach((m, i) => {
    d.getRange(i + 2, 1).setValue(m.label);
    langs.forEach((l, j) => {
      let v = 0;
      if (m.key === "Unassigned") {
        v = p.filter(r => r[pIdx.Language] === l && r[pIdx.AssignmentStatus] === "Unassigned").length;
      } else if (m.key === "Assigned") {
        v = p.filter(r => r[pIdx.Language] === l && r[pIdx.AssignmentStatus] === "Assigned").length;
      } else if (m.key === "TotalGroups") {
        v = g.filter(r => r[gIdx.Language] === l).length;
      } else if (m.key === "ActiveGroups") {
        v = g.filter(r => r[gIdx.Language] === l && r[gIdx.Status] === "Active").length;
      } else if (m.key === "NoCoordinator") {
        v = g.filter(r => r[gIdx.Language] === l && !r[gIdx.CoordinatorEmail]).length;
      }
      d.getRange(i + 2, j + 2).setValue(v);
    });
  });
}

/************************************************
 * HELPERS
 ************************************************/
function indexMap(h) { const m = {}; h.forEach((x, i) => m[x] = i); return m; }
function splitSlots(s) { return String(s || "").split(",").map(x => x.trim()).filter(Boolean); }
function normalizeLanguage(v) {
  const m = { english: "English", tamil: "Tamil", hindi: "Hindi", kannada: "Kannada", telugu: "Telugu" };
  const k = String(v || "").toLowerCase().trim();
  return m[k] || v;
}
function getNextParticipantIdStart(sh, idx) {
  const d = sh.getDataRange().getValues(); let m = 0;
  for (let i = 1; i < d.length; i++) {
    if (/^P-\d+/.test(d[i][idx])) m = Math.max(m, Number(d[i][idx].replace("P-", "")));
  }
  return m + 1;
}
function getNextGroupSequence(d, idx, l) {
  return Math.max(0, ...d.filter(r => r[idx.Language] === l).map(r => Number(r[idx.Sequence]) || 0)) + 1;
}
