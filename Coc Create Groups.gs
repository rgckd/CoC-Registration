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

  // Get initial data and headers
  let sData = src.getDataRange().getValues();
  let sHeaders = sData[0];
  
  // Check if "Processed" column exists, if not add it
  let processedColIndex = sHeaders.indexOf("Processed");
  if (processedColIndex === -1) {
    const lastCol = src.getLastColumn();
    src.getRange(1, lastCol + 1).setValue("Processed");
    // Re-fetch data with the new column
    sData = src.getDataRange().getValues();
    sHeaders = sData[0];
    processedColIndex = sHeaders.indexOf("Processed");
  }
  
  const tData = tgt.getDataRange().getValues();
  const tHeaders = tData.shift();
  
  // Remove headers from source data
  sData.shift();

  const sIdx = indexMap(sHeaders);
  const tIdx = indexMap(tHeaders);

  let nextId = getNextParticipantIdStart(tgt, tIdx.ParticipantID);
  let rows = [];
  let processedRowIndices = [];

  sData.forEach((r, index) => {
    const email = r[sIdx.Email];
    const isProcessed = r[sIdx.Processed] === true || r[sIdx.Processed] === "TRUE";
    
    if (!email || isProcessed) return;

    const newRow = new Array(tHeaders.length).fill("");
    newRow[tIdx.ParticipantID] = "P-" + String(nextId++).padStart(4, "0");
    newRow[tIdx.Name] = r[sIdx.Name];
    newRow[tIdx.Email] = email;
    newRow[tIdx.WhatsApp] = r[sIdx.WhatsApp];
    newRow[tIdx.Language] = normalizeLanguage(r[sIdx.Language]);
    newRow[tIdx.Center] = r[sIdx.Center];
    newRow[tIdx.PreferredSlots] = r[sIdx.PreferredTimes];
    newRow[tIdx.CoordinatorWilling] = r[sIdx.Coordinator] === "Yes";
    newRow[tIdx.AssignedGroup] = "";
    newRow[tIdx.AssignmentStatus] = "Unassigned";
    newRow[tIdx.IsGroupCoordinator] = false;
    newRow[tIdx.AcceptSuggestion] = false;
    newRow[tIdx.SuggestedGroup] = "";
    if (tIdx.Notes !== undefined) newRow[tIdx.Notes] = "";
    if (tIdx.IsActive !== undefined) newRow[tIdx.IsActive] = true;

    rows.push(newRow);
    processedRowIndices.push(index + 2); // +2 because of header row and 1-based indexing
  });

  if (rows.length) {
    tgt.getRange(tgt.getLastRow() + 1, 1, rows.length, rows[0].length)
      .setValues(rows);
    
    // Mark processed rows in CustomForm using column index + 1 (1-based)
    processedRowIndices.forEach(rowNum => {
      src.getRange(rowNum, sIdx.Processed + 1).setValue(true);
    });
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

  ensureGroupIds(gSheet, gData, gIdx);

  const participants = pData
    .map((r, i) => ({ row: i + 2, data: r }))
    .filter(p =>
      p.data[pIdx.Language] === language &&
      p.data[pIdx.AssignmentStatus] === "Unassigned"
    );

  // Group participants by first preferred time slot
  const slotGroups = {};
  participants.forEach(p => {
    const slots = splitSlots(p.data[pIdx.PreferredSlots]);
    const firstSlot = slots[0] || "TBD";
    if (!slotGroups[firstSlot]) {
      slotGroups[firstSlot] = [];
    }
    slotGroups[firstSlot].push(p);
  });

  let seq = getNextGroupSequenceByCount(gData, gIdx, language);

  // Process each time slot group
  Object.keys(slotGroups).forEach(slot => {
    const group = slotGroups[slot];
    
    // Skip groups with less than 5 members
    if (group.length < 5) {
      return;
    }
    
    const hasCoordinator = group.some(p => p.data[pIdx.CoordinatorWilling] === true);
    
    // Split large groups into subgroups of 5-8 members
    const subgroups = [];
    let remaining = group.length;
    let index = 0;
    
    while (remaining > 0) {
      if (remaining <= 8) {
        // Last group - take all remaining if >= 5
        if (remaining >= 5) {
          subgroups.push(group.slice(index));
        }
        break;
      } else if (remaining <= 13) {
        // Split into two groups (to avoid creating a group < 5)
        const firstGroupSize = Math.ceil(remaining / 2);
        subgroups.push(group.slice(index, index + firstGroupSize));
        subgroups.push(group.slice(index + firstGroupSize));
        break;
      } else {
        // Take 8 members
        subgroups.push(group.slice(index, index + 8));
        index += 8;
        remaining -= 8;
      }
    }

    // Assign same sequence to all members in each subgroup
    subgroups.forEach(subgroup => {
      const groupName = `NEW → CoC-${language}-${String(seq).padStart(3, "0")} (${slot})`;
      subgroup.forEach(p => {
        pSheet.getRange(p.row, pIdx.SuggestedGroup + 1).setValue(groupName);
      });
      seq++; // Increment for next group
    });
  });
}

/************************************************
 * ACCEPT GROUP SUGGESTIONS
 * - Creates groups
 * - Assigns participants
 * - Sends assignment emails
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

  const processedParticipantIDs = [];

  // ============ PASS 1: UPDATE PARTICIPANTS & GROUPS ============
  
  // Filter and extract group names
  pData.forEach((row, i) => {
    if (row[pIdx.AcceptSuggestion] !== true) return;
    if (!row[pIdx.SuggestedGroup]) return;

    let groupName = "";
    let timing = "";

    // Pattern a: "NEW → CoC-Tamil-020 (Mon Morning)"
    const newPatternMatch = row[pIdx.SuggestedGroup].match(/NEW\s*→\s*(CoC-[^-]+-\d{3})\s*\(([^)]+)\)/);
    if (newPatternMatch) {
      groupName = newPatternMatch[1];
      timing = newPatternMatch[2];
    } else {
      // Pattern b: "CoC-Tamil-020"
      const directMatch = row[pIdx.SuggestedGroup].match(/CoC-[^-]+-\d{3}/);
      if (directMatch) {
        groupName = directMatch[0];
      }
    }

    if (!groupName) return;

    // Create group if doesn't exist
    if (!gData.some(g => g[gIdx.GroupName] === groupName)) {
      let day = "TBD";
      let time = "TBD";
      
      if (timing && timing !== "TBD") {
        const parts = timing.split(" ");
        day = parts[0] || "TBD";
        time = parts[1] || "TBD";
      }

      const newRow = new Array(gHeaders.length).fill("");
      newRow[gIdx.GroupID] = getNextGroupId(gData, gIdx);
      newRow[gIdx.GroupName] = groupName;
      newRow[gIdx.Language] = row[pIdx.Language];
      newRow[gIdx.Day] = day;
      newRow[gIdx.Time] = time;
      newRow[gIdx.CoordinatorEmail] = "";
      newRow[gIdx.CoordinatorName] = "";
      if (gIdx.CoordinatorWhatsApp !== undefined) newRow[gIdx.CoordinatorWhatsApp] = "";
      newRow[gIdx.MemberCount] = 0;
      newRow[gIdx.Status] = "Active";
      if (gIdx.WeeksCompleted !== undefined) newRow[gIdx.WeeksCompleted] = 0;
      if (gIdx.Notes !== undefined) newRow[gIdx.Notes] = "";

      gSheet.appendRow(newRow);
      gData.push(newRow);
    }

    // Update participant
    row[pIdx.AssignedGroup] = groupName;
    row[pIdx.AssignmentStatus] = "Assigned";
    row[pIdx.SuggestedGroup] = "";
    row[pIdx.AcceptSuggestion] = false;
    pData[i] = row;

    // Track ParticipantID for Pass 2
    processedParticipantIDs.push(row[pIdx.ParticipantID]);
  });

  // Write participant updates to sheet
  pSheet.getRange(2, 1, pData.length, pHeaders.length).setValues(pData);
  SpreadsheetApp.flush();

  // Refresh derived data to populate coordinator info
  updateGroupsSheet();
  updateAdminDashboard();

  // ============ PASS 2: SEND EMAILS (WITH COMPLETE DATA) ============
  
  // Reload fresh data from sheets
  const pDataFresh = pSheet.getDataRange().getValues();
  const gDataFresh = gSheet.getDataRange().getValues();
  
  const pHeadersFresh = pDataFresh.shift();
  const gHeadersFresh = gDataFresh.shift();
  
  const pIdxFresh = indexMap(pHeadersFresh);
  const gIdxFresh = indexMap(gHeadersFresh);

  // Send emails only for processed participants
  processedParticipantIDs.forEach(participantID => {
    const participantRow = pDataFresh.find(r => r[pIdxFresh.ParticipantID] === participantID);
    if (!participantRow) return;

    const groupName = participantRow[pIdxFresh.AssignedGroup];
    const groupRow = gDataFresh.find(g => g[gIdxFresh.GroupName] === groupName);
    if (!groupRow) return;

    const groupInfo = {
      name: groupRow[gIdxFresh.GroupName],
      day: groupRow[gIdxFresh.Day] || "TBD",
      time: groupRow[gIdxFresh.Time] || "TBD",
      coordinatorName: groupRow[gIdxFresh.CoordinatorName] || "",
      coordinatorEmail: groupRow[gIdxFresh.CoordinatorEmail] || "",
      coordinatorWhatsApp: gIdxFresh.CoordinatorWhatsApp !== undefined ? (groupRow[gIdxFresh.CoordinatorWhatsApp] || "") : ""
    };

    const isCoordinator = participantRow[pIdxFresh.IsGroupCoordinator] === true || participantRow[pIdxFresh.IsGroupCoordinator] === "TRUE" || participantRow[pIdxFresh.IsGroupCoordinator] === "true";

    if (isCoordinator) {
      // Send coordinator email with all members
      const members = pDataFresh.filter(r => r[pIdxFresh.AssignedGroup] === groupName)
        .map(r => ({
          name: r[pIdxFresh.Name],
          email: r[pIdxFresh.Email],
          whatsapp: r[pIdxFresh.WhatsApp]
        }));
      sendCoordinatorAssignmentEmail(participantRow[pIdxFresh.Email], participantRow[pIdxFresh.Name], participantRow[pIdxFresh.Language], groupInfo, members);
    } else {
      // Send member email with coordinator info
      sendMemberAssignmentEmail(participantRow[pIdxFresh.Email], participantRow[pIdxFresh.Name], participantRow[pIdxFresh.Language], groupInfo);
    }
  });
}

/************************************************
 * REFRESH (DERIVED DATA)
 ************************************************/
function refreshGroupsAndDashboard() {
  updateGroupsSheet();
  updateAdminDashboard();
}

/************************************************
 * UPDATE GROUPS (DERIVED FIELDS + CREATE MISSING)
 ************************************************/
function updateGroupsSheet() {
  const ss = SpreadsheetApp.getActive();
  const pSheet = ss.getSheetByName("Participants");
  const gSheet = ss.getSheetByName("Groups");

  const pData = pSheet.getDataRange().getValues();
  const gData = gSheet.getDataRange().getValues();

  const pHeaders = pData.shift();
  const gHeaders = gData.shift();

  const pIdx = indexMap(pHeaders);
  const gIdx = indexMap(gHeaders);

  // Build member map
  const members = {};
  pData.forEach(r => {
    if (!r[pIdx.AssignedGroup]) return;

    if (!members[r[pIdx.AssignedGroup]]) {
      members[r[pIdx.AssignedGroup]] = [];
    }

    members[r[pIdx.AssignedGroup]].push(r);
  });

  // Find existing group names
  const existingGroups = new Set(gData.map(r => r[gIdx.GroupName]).filter(Boolean));

  // Create missing groups
  const newGroups = [];
  Object.keys(members).forEach(groupName => {
    if (!existingGroups.has(groupName)) {
      const firstMember = members[groupName][0];
      const language = firstMember[pIdx.Language];
      
      // Parse day/time from group name or use first member's slot
      let day = "", time = "";
      const slots = splitSlots(firstMember[pIdx.PreferredSlots]);
      if (slots.length > 0) {
        const parts = slots[0].split(" ");
        day = parts[0] || "";
        time = parts[1] || "";
      }

      // Get sequence number from group name
      const seqMatch = groupName.match(/-(\d{3})$/);
      const seq = seqMatch ? parseInt(seqMatch[1], 10) : gData.filter(r => r[gIdx.Language] === language).length + 1;

      // Find coordinator in the group members
      const coordinator = members[groupName].find(m => {
        const val = m[pIdx.IsGroupCoordinator];
        return val === true || val === "TRUE" || val === "true";
      });

      const newRow = new Array(gHeaders.length).fill("");
      newRow[gIdx.GroupID] = getNextGroupId(gData, gIdx);
      newRow[gIdx.GroupName] = groupName;
      newRow[gIdx.Language] = language;
      newRow[gIdx.Day] = day;
      newRow[gIdx.Time] = time;
      newRow[gIdx.CoordinatorEmail] = coordinator ? coordinator[pIdx.Email] : "";
      newRow[gIdx.CoordinatorName] = coordinator ? coordinator[pIdx.Name] : "";
      if (gIdx.CoordinatorWhatsApp !== undefined) {
        newRow[gIdx.CoordinatorWhatsApp] = coordinator ? coordinator[pIdx.WhatsApp] : "";
      }
      newRow[gIdx.MemberCount] = 0;
      newRow[gIdx.Status] = "Active";
      if (gIdx.WeeksCompleted !== undefined) newRow[gIdx.WeeksCompleted] = 0;
      if (gIdx.Notes !== undefined) newRow[gIdx.Notes] = "";

      newGroups.push(newRow);

      existingGroups.add(groupName);
    }
  });

  // Append new groups
  if (newGroups.length > 0) {
    gSheet.getRange(gSheet.getLastRow() + 1, 1, newGroups.length, newGroups[0].length)
      .setValues(newGroups);
    
    // Refresh gData to include new groups
    const updatedGData = gSheet.getDataRange().getValues();
    updatedGData.shift(); // Remove header
    gData.length = 0;
    gData.push(...updatedGData);
  }

  // Update all groups with member count and coordinator
  gData.forEach(r => {
    const m = members[r[gIdx.GroupName]] || [];
    r[gIdx.MemberCount] = m.length;

    // Find coordinator (checkbox can be true, TRUE, or "TRUE")
    const c = m.find(x => {
      const val = x[pIdx.IsGroupCoordinator];
      return val === true || val === "TRUE" || val === "true";
    });
    r[gIdx.CoordinatorName] = c ? c[pIdx.Name] : "";
    r[gIdx.CoordinatorEmail] = c ? c[pIdx.Email] : "";
    if (gIdx.CoordinatorWhatsApp !== undefined) {
      r[gIdx.CoordinatorWhatsApp] = c ? c[pIdx.WhatsApp] : "";
    }
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
    { key: "TotalGroups", label: "Total Groups" },
    { key: "ActiveGroups", label: "Active Groups" },
    { key: "NoCoordinator", label: "Groups without Coordinator" },
    { key: "Assigned", label: "Assigned Participants" },
    { key: "ActiveParticipants", label: "Active Participants" },
    { key: "Unassigned", label: "Unassigned Participants" }
  ];

  d.getRange(2, 1, 50, 10).clearContent();

  metrics.forEach((m, i) => {
    d.getRange(i + 2, 1).setValue(m.label);
    langs.forEach((l, j) => {
      let v = 0;
      if (m.key === "ActiveParticipants") {
        v = p.filter(r => r[pIdx.Language] === l && r[pIdx.IsActive] === true).length;
      } else if (m.key === "Unassigned") {
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
function indexMap(h) { const m = {}; h.forEach((x, i) => m[String(x).trim()] = i); return m; }
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
function getNextGroupSequenceByCount(d, idx, l) {
  return d.filter(r => r[idx.Language] === l).length + 1;
}
function getNextGroupId(d, idx) {
  let maxId = 0;
  d.forEach(r => {
    const id = r[idx.GroupID];
    const n = typeof id === "string" && id.match(/G-(\d+)/)
      ? Number(id.replace("G-", ""))
      : 0;
    if (!Number.isNaN(n)) {
      maxId = Math.max(maxId, n);
    }
  });
  return "G-" + String(maxId + 1).padStart(4, "0");
}
function ensureGroupIds(d, idx) {
  if (idx.GroupID === undefined) return;
  let changed = false;
  for (let i = 0; i < d.length; i++) {
    if (!d[i][idx.GroupID]) {
      d[i][idx.GroupID] = getNextGroupId(d, idx);
      changed = true;
    }
  }
  if (changed) {
    const sh = SpreadsheetApp.getActive().getSheetByName("Groups");
    const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    sh.getRange(2, 1, d.length, headers.length).setValues(d);
  }
}

/************************************************
 * EMAIL NOTIFICATIONS FOR GROUP ASSIGNMENTS
 ************************************************/
function sendMemberAssignmentEmail(email, name, language, groupInfo) {
  const labels = getEmailLabels(language);
  
  const subject = labels.memberSubject;
  const htmlBody = `
    <p>Dear ${name},</p>
    <p>${labels.memberIntro}</p>
    <p><strong>${labels.groupName}:</strong> ${groupInfo.name}</p>
    <p><strong>${labels.schedule}:</strong> ${groupInfo.day} ${groupInfo.time}</p>
    <br>
    <p><strong>${labels.coordinatorInfo}:</strong></p>
    <p><strong>${labels.name}:</strong> ${groupInfo.coordinatorName}</p>
    <p><strong>${labels.email}:</strong> ${groupInfo.coordinatorEmail}</p>
    <p><strong>${labels.whatsapp}:</strong> ${groupInfo.coordinatorWhatsApp}</p>
    <br>
    <p>${labels.memberClosing}</p>
    <p>${labels.regards}</p>
  `;
  
  MailApp.sendEmail({
    to: email,
    subject: subject,
    htmlBody: htmlBody
  });
}

function sendCoordinatorAssignmentEmail(email, name, language, groupInfo, members) {
  const labels = getEmailLabels(language);
  
  const memberListHtml = members.map(m => `
    <tr>
      <td>${m.name}</td>
      <td>${m.email}</td>
      <td>${m.whatsapp}</td>
    </tr>
  `).join('');
  
  const subject = labels.coordinatorSubject;
  const htmlBody = `
    <p>Dear ${name},</p>
    <p>${labels.coordinatorIntro}</p>
    <p><strong>${labels.groupName}:</strong> ${groupInfo.name}</p>
    <p><strong>${labels.schedule}:</strong> ${groupInfo.day} ${groupInfo.time}</p>
    <br>
    <p><strong>${labels.membersTitle}:</strong></p>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
      <tr>
        <th>${labels.name}</th>
        <th>${labels.email}</th>
        <th>${labels.whatsapp}</th>
      </tr>
      ${memberListHtml}
    </table>
    <br>
    <p>${labels.coordinatorClosing}</p>
    <p>${labels.regards}</p>
  `;
  
  MailApp.sendEmail({
    to: email,
    subject: subject,
    htmlBody: htmlBody
  });
}

function getEmailLabels(language) {
  const allLabels = {
    English: {
      memberSubject: "CoC Group Assignment Confirmation",
      memberIntro: "You have been assigned to a CoC study group!",
      coordinatorSubject: "CoC Group Coordinator Assignment",
      coordinatorIntro: "You have been assigned as the coordinator for a CoC study group!",
      groupName: "Group Name",
      schedule: "Schedule",
      coordinatorInfo: "Your Group Coordinator",
      membersTitle: "Group Members",
      name: "Name",
      email: "Email",
      whatsapp: "WhatsApp",
      memberClosing: "Your coordinator will reach out to you soon with further details.",
      coordinatorClosing: "Please reach out to your group members to schedule the first session.",
      regards: "Best regards,<br>CoC Team"
    },
    Tamil: {
      memberSubject: "CoC குழு ஒதுக்கீடு உறுதிப்படுத்தல்",
      memberIntro: "நீங்கள் CoC படிப்பு குழுவில் சேர்க்கப்பட்டுள்ளீர்கள்!",
      coordinatorSubject: "CoC குழு ஒருங்கிணைப்பாளர் ஒதுக்கீடு",
      coordinatorIntro: "நீங்கள் CoC படிப்பு குழுவின் ஒருங்கிணைப்பாளராக நியமிக்கப்பட்டுள்ளீர்கள்!",
      groupName: "குழு பெயர்",
      schedule: "அட்டவணை",
      coordinatorInfo: "உங்கள் குழு ஒருங்கிணைப்பாளர்",
      membersTitle: "குழு உறுப்பினர்கள்",
      name: "பெயர்",
      email: "மின்னஞ்சல்",
      whatsapp: "வாட்ஸாப்",
      memberClosing: "உங்கள் ஒருங்கிணைப்பாளர் விரைவில் மேலும் விவரங்களுடன் உங்களை தொடர்பு கொள்வார்.",
      coordinatorClosing: "முதல் அமர்வை திட்டமிட உங்கள் குழு உறுப்பினர்களை தொடர்பு கொள்ளவும்.",
      regards: "நன்றி,<br>CoC குழு"
    },
    Hindi: {
      memberSubject: "CoC समूह असाइनमेंट की पुष्टि",
      memberIntro: "आपको CoC अध्ययन समूह में नियुक्त किया गया है!",
      coordinatorSubject: "CoC समूह समन्वयक असाइनमेंट",
      coordinatorIntro: "आपको CoC अध्ययन समूह के समन्वयक के रूप में नियुक्त किया गया है!",
      groupName: "समूह का नाम",
      schedule: "कार्यक्रम",
      coordinatorInfo: "आपके समूह समन्वयक",
      membersTitle: "समूह के सदस्य",
      name: "नाम",
      email: "ईमेल",
      whatsapp: "व्हाट्सएप",
      memberClosing: "आपके समन्वयक जल्द ही अधिक विवरण के साथ आपसे संपर्क करेंगे।",
      coordinatorClosing: "कृपया पहला सत्र निर्धारित करने के लिए अपने समूह सदस्यों से संपर्क करें।",
      regards: "सादर,<br>CoC टीम"
    },
    Kannada: {
      memberSubject: "CoC ಗುಂಪು ನಿಯೋಜನೆ ದೃಢೀಕರಣ",
      memberIntro: "ನೀವು CoC ಅಧ್ಯಯನ ಗುಂಪಿಗೆ ನಿಯೋಜಿಸಲ್ಪಟ್ಟಿದ್ದೀರಿ!",
      coordinatorSubject: "CoC ಗುಂಪು ಸಮನ್ವಯಕ ನಿಯೋಜನೆ",
      coordinatorIntro: "ನೀವು CoC ಅಧ್ಯಯನ ಗುಂಪಿನ ಸಮನ್ವಯಕರಾಗಿ ನಿಯೋಜಿಸಲ್ಪಟ್ಟಿದ್ದೀರಿ!",
      groupName: "ಗುಂಪಿನ ಹೆಸರು",
      schedule: "ವೇಳಾಪಟ್ಟಿ",
      coordinatorInfo: "ನಿಮ್ಮ ಗುಂಪು ಸಮನ್ವಯಕ",
      membersTitle: "ಗುಂಪು ಸದಸ್ಯರು",
      name: "ಹೆಸರು",
      email: "ಇಮೇಲ್",
      whatsapp: "ವಾಟ್ಸಾಪ್",
      memberClosing: "ನಿಮ್ಮ ಸಮನ್ವಯಕ ಶೀಘ್ರದಲ್ಲೇ ಹೆಚ್ಚಿನ ವಿವರಗಳೊಂದಿಗೆ ನಿಮ್ಮನ್ನು ಸಂಪರ್ಕಿಸುತ್ತಾರೆ.",
      coordinatorClosing: "ಮೊದಲ ಅಧಿವೇಶನವನ್ನು ನಿಗದಿಪಡಿಸಲು ದಯವಿಟ್ಟು ನಿಮ್ಮ ಗುಂಪು ಸದಸ್ಯರನ್ನು ಸಂಪರ್ಕಿಸಿ.",
      regards: "ಧನ್ಯವಾದಗಳು,<br>CoC ತಂಡ"
    },
    Telugu: {
      memberSubject: "CoC గ్రూప్ అసైన్‌మెంట్ నిర్ధారణ",
      memberIntro: "మీరు CoC అధ్యయన సమూహానికి కేటాయించబడ్డారు!",
      coordinatorSubject: "CoC గ్రూప్ సమన్వయకర్త అసైన్‌మెంట్",
      coordinatorIntro: "మీరు CoC అధ్యయన సమూహానికి సమన్వయకర్తగా కేటాయించబడ్డారు!",
      groupName: "సమూహం పేరు",
      schedule: "షెడ్యూల్",
      coordinatorInfo: "మీ సమూహ సమన్వయకర్త",
      membersTitle: "సమూహ సభ్యులు",
      name: "పేరు",
      email: "ఇమెయిల్",
      whatsapp: "వాట్సాప్",
      memberClosing: "మీ సమన్వయకర్త త్వరలో మరిన్ని వివరాలతో మిమ్మల్ని సంప్రదిస్తారు.",
      coordinatorClosing: "దయచేసి మొదటి సెషన్‌ను షెడ్యూల్ చేయడానికి మీ సమూహ సభ్యులను సంప్రదించండి.",
      regards: "శుభాకాంక్షలు,<br>CoC బృందం"
    }
  };
  
  return allLabels[language] || allLabels.English;
}
