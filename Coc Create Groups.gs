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
    .addItem("Accept Group Suggestions Without Emailing", "acceptGroupSuggestionsNoEmail")
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
function acceptGroupSuggestionsNoEmail() { acceptGroupSuggestions(false); }

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

  // Group rows by email and keep only the most recent submission for each email
  const emailMap = {};
  const emailIndices = {}; // Track all indices for each email
  
  sData.forEach((r, index) => {
    const email = r[sIdx.Email];
    const isProcessed = r[sIdx.Processed] === true || r[sIdx.Processed] === "TRUE";
    
    if (!email || isProcessed) return;

    // Track all indices for this email
    if (!emailIndices[email]) {
      emailIndices[email] = [];
    }
    emailIndices[email].push(index);

    const timestamp = r[sIdx.Timestamp] instanceof Date ? r[sIdx.Timestamp] : new Date(r[sIdx.Timestamp]);
    
    if (!emailMap[email] || timestamp > emailMap[email].timestamp) {
      emailMap[email] = {
        row: r,
        index: index,
        timestamp: timestamp
      };
    }
  });

  // Process only the most recent submission for each email
  Object.values(emailMap).forEach(entry => {
    const r = entry.row;
    const email = r[sIdx.Email];

    const newRow = new Array(tHeaders.length).fill("");
    newRow[tIdx.ParticipantID] = "P-" + String(nextId++).padStart(4, "0");
    newRow[tIdx.Name] = r[sIdx.Name];
    newRow[tIdx.Email] = email;
    newRow[tIdx.WhatsApp] = r[sIdx.WhatsApp];
    newRow[tIdx.Language] = normalizeLanguage(r[sIdx.Language]);
    newRow[tIdx.Center] = r[sIdx.Center];
    if (tIdx.EnglishProficiency !== undefined && sIdx.EnglishAbility !== undefined) {
      newRow[tIdx.EnglishProficiency] = r[sIdx.EnglishAbility] || "";
    }
    newRow[tIdx.PreferredSlots] = r[sIdx.PreferredTimes];
    newRow[tIdx.CoordinatorWilling] = r[sIdx.Coordinator] === "Yes";
    newRow[tIdx.AssignedGroup] = "";
    newRow[tIdx.AssignmentStatus] = "Unassigned";
    newRow[tIdx.IsGroupCoordinator] = false;
    newRow[tIdx.AcceptSuggestion] = false;
    newRow[tIdx.SuggestedGroup] = "";
    if (tIdx.Comments !== undefined && sIdx.Comments !== undefined) {
      newRow[tIdx.Comments] = r[sIdx.Comments] || "";
    }
    if (tIdx.IsActive !== undefined) newRow[tIdx.IsActive] = true;

    rows.push(newRow);
    
    // Mark ALL records with this email as processed (including duplicates)
    emailIndices[email].forEach(index => {
      processedRowIndices.push(index + 2); // +2 because of header row and 1-based indexing
    });
  });

  if (rows.length) {
    tgt.getRange(tgt.getLastRow() + 1, 1, rows.length, rows[0].length)
      .setValues(rows);
    
    // Mark processed rows in CustomForm using column index + 1 (1-based)
    processedRowIndices.forEach(rowNum => {
      src.getRange(rowNum, sIdx.Processed + 1).setValue(true);
    });

    // Refresh groups and dashboard after populating participants
    refreshGroupsAndDashboard();
  }
}

/************************************************
 * DAILY BATCH PROCESSING WITH ALERTS
 * 
 * This function is designed to run daily (via time-based trigger).
 * It populates participants from CustomForm and sends alert emails
 * to language admins when new participants need group assignment.
 * 
 * SETUP INSTRUCTIONS:
 * 1. Go to Apps Script Editor > Project Settings > Script Properties
 * 2. Add the following properties with admin email addresses:
 *    - ADMIN_EMAIL_ENGLISH
 *    - ADMIN_EMAIL_TAMIL
 *    - ADMIN_EMAIL_HINDI
 *    - ADMIN_EMAIL_KANNADA
 *    - ADMIN_EMAIL_TELUGU
 * 3. Set up a time-based trigger:
 *    - Go to Triggers (clock icon)
 *    - Click "+ Add Trigger"
 *    - Choose function: dailyParticipantProcessingWithAlerts
 *    - Event source: Time-driven
 *    - Type: Day timer
 *    - Time of day: Choose preferred time (e.g., 9am to 10am)
 ************************************************/
function dailyParticipantProcessingWithAlerts() {
  const ss = SpreadsheetApp.getActive();
  const tgt = ss.getSheetByName("Participants");
  
  // Get participants count before processing
  const rowsBeforeProcessing = tgt.getLastRow() - 1; // -1 for header
  
  // Run populate participants
  populateParticipantsFromCustomForm();
  
  // Get participants count after processing
  const rowsAfterProcessing = tgt.getLastRow() - 1;
  const newParticipantsCount = rowsAfterProcessing - rowsBeforeProcessing;
  
  Logger.log("=== Daily Batch Processing Summary ===");
  Logger.log(`Total new participants processed: ${newParticipantsCount}`);
  
  // If no new participants, exit
  if (newParticipantsCount <= 0) {
    Logger.log("No new participants to process");
    return;
  }
  
  // Get the newly added participants (last N rows)
  const pData = tgt.getDataRange().getValues();
  const pHeaders = pData.shift();
  const pIdx = indexMap(pHeaders);
  
  const newParticipants = pData.slice(-newParticipantsCount);
  
  // Group new participants by language
  const participantsByLanguage = {};
  const languages = ["English", "Tamil", "Hindi", "Kannada", "Telugu"];
  
  languages.forEach(lang => {
    participantsByLanguage[lang] = newParticipants.filter(p => 
      p[pIdx.Language] === lang && p[pIdx.AssignmentStatus] === "Unassigned"
    );
  });
  
  // Get language admin emails from script properties
  const props = PropertiesService.getScriptProperties();
  
  // Log breakdown by language
  Logger.log("Breakdown by language (unassigned only):");
  languages.forEach(lang => {
    const count = participantsByLanguage[lang].length;
    Logger.log(`  ${lang}: ${count}`);
  });
  
  // Send emails to language admins
  let emailsSent = 0;
  let emailsFailed = 0;
  
  languages.forEach(lang => {
    const participants = participantsByLanguage[lang];
    if (participants.length === 0) return;
    
    const adminEmail = props.getProperty(`ADMIN_EMAIL_${lang.toUpperCase()}`);
    if (!adminEmail) {
      Logger.log(`No admin email configured for ${lang}`);
      return;
    }
    
    try {
      sendAdminAlertEmail(adminEmail, lang, participants, pIdx);
      Logger.log(`Alert sent to ${lang} admin: ${adminEmail}`);
      emailsSent++;
    } catch (error) {
      Logger.log(`Failed to send alert to ${lang} admin: ${error.message}`);
      emailsFailed++;
    }
  });
  
  Logger.log(`Emails sent: ${emailsSent}, Emails failed: ${emailsFailed}`);
  Logger.log("=== Batch Processing Complete ===");
}

/************************************************
 * WEEKLY LIFECYCLE PROCESSING
 * - Close Completed groups -> Closed
 * - Terminate Inactive groups -> Terminated
 * - Send per-language admin summary email
 ************************************************/
function weeklyLifecycleProcessing() {
  const ss = SpreadsheetApp.getActive();
  const pSheet = ss.getSheetByName("Participants");
  const gSheet = ss.getSheetByName("Groups");

  const pData = pSheet.getDataRange().getValues();
  const gData = gSheet.getDataRange().getValues();
  const pHeaders = pData.shift();
  const gHeaders = gData.shift();
  const pIdx = indexMap(pHeaders);
  const gIdx = indexMap(gHeaders);

  // Build group status map by name
  const groupStatusByName = {};
  gData.forEach(r => {
    if (gIdx.GroupName !== undefined && gIdx.Status !== undefined) {
      const name = String(r[gIdx.GroupName] || "").trim();
      if (name) groupStatusByName[name] = String(r[gIdx.Status] || "").trim();
    }
  });

  // Track changes for admin summary
  const summary = {
    closed: {},        // lang -> [{groupName, count}]
    terminated: {},    // lang -> [{groupName, count}]
    discontinued: {}   // lang -> count
  };

  const emailFailures = [];

  const registerClosed = (lang, groupName, count) => {
    summary.closed[lang] = summary.closed[lang] || [];
    summary.closed[lang].push({ groupName: groupName, count: count });
  };
  const registerTerminated = (lang, groupName, count) => {
    summary.terminated[lang] = summary.terminated[lang] || [];
    summary.terminated[lang].push({ groupName: groupName, count: count });
  };
  const registerDiscontinued = (lang) => {
    summary.discontinued[lang] = (summary.discontinued[lang] || 0) + 1;
  };

  // Helpers: send lifecycle emails
  const REG_LINK = "https://www.hcessentials.org/coc-registration-form";
  const sendClosedEmail = (email, name, groupName, wasActive, language) => {
    const labels = getLifecycleEmailLabels(language);
    const subject = labels.closedSubject.replace('{groupName}', groupName);
    const body = wasActive 
      ? labels.closedBodyActive.replace('{name}', name).replace('{groupName}', groupName).replace('{regLink}', REG_LINK)
      : labels.closedBodyInactive.replace('{name}', name).replace('{groupName}', groupName).replace('{regLink}', REG_LINK);
    MailApp.sendEmail({ to: email, subject, body });
  };
  const sendTerminatedEmail = (email, name, groupName, language) => {
    const labels = getLifecycleEmailLabels(language);
    const subject = labels.terminatedSubject.replace('{groupName}', groupName);
    const body = labels.terminatedBody.replace('{name}', name).replace('{groupName}', groupName).replace('{regLink}', REG_LINK);
    MailApp.sendEmail({ to: email, subject, body });
  };
  const sendDiscontinuedEmail = (email, name, groupName, language) => {
    const labels = getLifecycleEmailLabels(language);
    const subject = labels.discontinuedSubject.replace('{groupName}', groupName);
    const body = labels.discontinuedBody.replace('{name}', name).replace('{groupName}', groupName).replace('{regLink}', REG_LINK);
    MailApp.sendEmail({ to: email, subject, body });
  };

  // Helper to list participants for a group
  const listGroupParticipants = (groupName) => {
    return pData.filter(r => pIdx.AssignedGroup !== undefined && String(r[pIdx.AssignedGroup] || "").trim() === groupName);
  };

  // 1) Close Completed groups -> Closed
  gData.forEach((gRow, gi) => {
    const status = String(gRow[gIdx.Status] || "").trim();
    if (status === "Completed") {
      const groupName = String(gRow[gIdx.GroupName] || "").trim();
      const lang = String(gRow[gIdx.Language] || "").trim();
      const members = listGroupParticipants(groupName);

      // Update group status
      gRow[gIdx.Status] = "Closed";
      gData[gi] = gRow;

      // Update members: AssignmentStatus = Completed, IsActive = FALSE, email based on original activity
      members.forEach((pRow, pi) => {
        const email = String(pRow[pIdx.Email] || "").trim();
        const name = String(pRow[pIdx.Name] || "").trim();
        const memberLang = String(pRow[pIdx.Language] || "").trim() || lang;
        const wasActive = !!toBool(pRow[pIdx.IsActive]);
        // set status
        if (pIdx.AssignmentStatus !== undefined) pRow[pIdx.AssignmentStatus] = "Completed";
        if (pIdx.IsActive !== undefined) pRow[pIdx.IsActive] = false;
        try {
          sendClosedEmail(email, name, groupName, wasActive, memberLang);
        } catch (err) {
          emailFailures.push({ type: "Closed group email", lang, group: groupName, email, name, reason: err.message });
        }
      });

      // Register summary
      registerClosed(lang, groupName, members.length);
    }
  });

  // 2) Terminate Inactive groups -> Terminated
  gData.forEach((gRow, gi) => {
    const status = String(gRow[gIdx.Status] || "").trim();
    if (status === "Inactive") {
      const groupName = String(gRow[gIdx.GroupName] || "").trim();
      const lang = String(gRow[gIdx.Language] || "").trim();
      const members = listGroupParticipants(groupName);

      // Update group status
      gRow[gIdx.Status] = "Terminated";
      gData[gi] = gRow;

      // Update members: AssignmentStatus = Discontinued, IsActive = FALSE, email
      members.forEach((pRow, pi) => {
        const email = String(pRow[pIdx.Email] || "").trim();
        const name = String(pRow[pIdx.Name] || "").trim();
        const memberLang = String(pRow[pIdx.Language] || "").trim() || lang;
        if (pIdx.AssignmentStatus !== undefined) pRow[pIdx.AssignmentStatus] = "Discontinued";
        if (pIdx.IsActive !== undefined) pRow[pIdx.IsActive] = false;
        try {
          sendTerminatedEmail(email, name, groupName, memberLang);
        } catch (err) {
          emailFailures.push({ type: "Terminated group email", lang, group: groupName, email, name, reason: err.message });
        }
        registerDiscontinued(memberLang);
      });

      // Register summary
      registerTerminated(lang, groupName, members.length);
    }
  });



  // Persist changes
  gSheet.getRange(2, 1, gData.length, gHeaders.length).setValues(gData);
  pSheet.getRange(2, 1, pData.length, pHeaders.length).setValues(pData);

  // Update Groups and Dashboard before sending emails
  updateAdminDashboard();

  // Send per-language admin summaries
  const props = PropertiesService.getScriptProperties();
  const masterUrl = String(props.getProperty('MASTER_SHEET_URL') || '').trim();
  const languages = ["English", "Tamil", "Hindi", "Kannada", "Telugu"];
  languages.forEach(lang => {
    const adminEmail = props.getProperty(`ADMIN_EMAIL_${lang.toUpperCase()}`);
    const closed = summary.closed[lang] || [];
    const terminated = summary.terminated[lang] || [];
    const discCount = summary.discontinued[lang] || 0;
    const failuresForLang = emailFailures.filter(f => f.lang === lang);
    const changesExist = closed.length || terminated.length || discCount || failuresForLang.length;
    if (adminEmail && changesExist) {
      const subject = `CoC Weekly Lifecycle Summary - ${lang}`;
      let lines = [];
      if (closed.length) {
        lines.push("Closed groups:");
        closed.forEach(c => lines.push(`- ${c.groupName} (members updated: ${c.count})`));
      }
      if (terminated.length) {
        lines.push("Terminated groups:");
        terminated.forEach(t => lines.push(`- ${t.groupName} (members updated: ${t.count})`));
      }
      if (discCount) {
        lines.push(`Discontinued participants: ${discCount}`);
      }
      if (failuresForLang.length) {
        lines.push("");
        lines.push("Email delivery issues:");
        failuresForLang.forEach(f => {
          const who = [f.name, f.email].filter(Boolean).join(" | ") || "Unknown";
          const grp = f.group ? ` [${f.group}]` : "";
          lines.push(`- ${f.type}${grp}: ${who} – ${f.reason}`);
        });
      }
      if (masterUrl) {
        lines.push("");
        lines.push(`CoC Master sheet: ${masterUrl}`);
      }
      const body = lines.join("\n");
      try {
        MailApp.sendEmail({ to: adminEmail, subject, body });
      } catch (err) {
        emailFailures.push({ type: "Admin summary email", lang, email: adminEmail, reason: err.message });
      }
    }
  });

  if (emailFailures.length) {
    Logger.log("Email send failures during weeklyLifecycleProcessing:");
    emailFailures.forEach(f => {
      const grp = f.group ? ` [${f.group}]` : "";
      Logger.log(`- ${f.lang}: ${f.type}${grp} -> ${f.email || "(no email)"} (${f.reason})`);
    });
  } else {
    Logger.log("No email send failures during weeklyLifecycleProcessing.");
  }
}

/************************************************
 * SEND ALERT EMAIL TO LANGUAGE ADMIN
 ************************************************/
function sendAdminAlertEmail(email, language, participants, pIdx) {
  const props = PropertiesService.getScriptProperties();
  const masterUrl = String(props.getProperty('MASTER_SHEET_URL') || '').trim();
  const subject = `CoC New Registrations Alert - ${language}`;
  
  const participantListHtml = participants.map(p => `
    <tr>
      <td>${p[pIdx.ParticipantID]}</td>
      <td>${p[pIdx.Name]}</td>
      <td>${p[pIdx.Email]}</td>
      <td>${p[pIdx.WhatsApp]}</td>
      <td>${p[pIdx.PreferredSlots]}</td>
      <td>${p[pIdx.CoordinatorWilling] ? 'Yes' : 'No'}</td>
    </tr>
  `).join('');
  
  const htmlBody = `
    <p>Dear ${language} Admin,</p>
    <p>There are <strong>${participants.length}</strong> new participant(s) registered for ${language} CoC groups who need to be assigned to groups.</p>
    <br>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
      <tr>
        <th>Participant ID</th>
        <th>Name</th>
        <th>Email</th>
        <th>WhatsApp</th>
        <th>Preferred Slots</th>
        <th>Willing to Coordinate</th>
      </tr>
      ${participantListHtml}
    </table>
    <br>
    <p>Please review these registrations and assign them to appropriate groups.</p>
    <br>
    ${masterUrl ? `<p>You can view all registrations here: <a href="${masterUrl}">CoC Registrations List</a></p>` : ''}
    <br>
    <p>Best regards,<br>CoC Admin System</p>
  `;
  
  MailApp.sendEmail({
    to: email,
    subject: subject,
    htmlBody: htmlBody
  });
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
      p.data[pIdx.AssignmentStatus] === "Unassigned" &&
      !p.data[pIdx.SuggestedGroup]
    );

  // Track summary counts
  const totalCandidates = participants.length;
  let suggestedCount = 0;
  let unsuggestedCount = 0;

  // If nothing to suggest, show a quick notice
  if (totalCandidates === 0) {
    SpreadsheetApp.getUi().alert(
      `Suggest Groups – ${language}`,
      `No unassigned participants found for ${language}.`,
      SpreadsheetApp.getUi().ButtonSet.OK
    );
    return;
  }

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

  // Build existing groups map by language, slot, and eligibility
  const existingGroups = gData
    .filter(g => 
      g[gIdx.Language] === language &&
      g[gIdx.Status] === "Active" &&
      (g[gIdx.WeeksCompleted] || 0) <= 5 &&
      g[gIdx.MemberCount] < 8
    )
    .map(g => ({
      name: g[gIdx.GroupName],
      day: g[gIdx.Day],
      time: g[gIdx.Time],
      memberCount: g[gIdx.MemberCount] || 0,
      capacity: 8 - (g[gIdx.MemberCount] || 0)
    }));

  let seq = getNextGroupSequenceByCount(gData, gIdx, language);

  // Process each time slot group
  Object.keys(slotGroups).forEach(slot => {
    let remainingParticipants = slotGroups[slot];
    
    // Parse the slot into day and time components
    const slotParts = slot.split(" ");
    const slotDay = slotParts[0] || "TBD";
    const slotTime = slotParts[1] || "TBD";
    
    // Find existing groups that match this time slot and have capacity
    const matchingGroups = existingGroups.filter(g => 
      g.day === slotDay && g.time === slotTime && g.capacity > 0
    ).sort((a, b) => a.memberCount - b.memberCount); // Fill smaller groups first

    // Assign to existing groups first
    matchingGroups.forEach(existingGroup => {
      if (remainingParticipants.length === 0) return;
      
      const toAssign = remainingParticipants.slice(0, existingGroup.capacity);
      toAssign.forEach(p => {
        pSheet.getRange(p.row, pIdx.SuggestedGroup + 1).setValue(existingGroup.name);
      });
      // Count suggestions to existing groups
      suggestedCount += toAssign.length;
      
      // Update capacity and remaining participants
      existingGroup.capacity -= toAssign.length;
      existingGroup.memberCount += toAssign.length;
      remainingParticipants = remainingParticipants.slice(toAssign.length);
    });

    // If there are still remaining participants, create new groups
    if (remainingParticipants.length < 5) {
      // Not enough for a new group, mark as unsuggested for this slot
      unsuggestedCount += remainingParticipants.length;
      return;
    }
    
    // Split remaining participants into subgroups of 5-8 members
    const subgroups = [];
    let remaining = remainingParticipants.length;
    let index = 0;
    
    while (remaining > 0) {
      if (remaining <= 8) {
        // Last group - take all remaining if >= 5
        if (remaining >= 5) {
          subgroups.push(remainingParticipants.slice(index));
        }
        break;
      } else if (remaining <= 13) {
        // Split into two groups (to avoid creating a group < 5)
        const firstGroupSize = Math.ceil(remaining / 2);
        subgroups.push(remainingParticipants.slice(index, index + firstGroupSize));
        subgroups.push(remainingParticipants.slice(index + firstGroupSize));
        break;
      } else {
        // Take 8 members
        subgroups.push(remainingParticipants.slice(index, index + 8));
        index += 8;
        remaining -= 8;
      }
    }

    // Assign to new groups
    subgroups.forEach(subgroup => {
      const groupName = `NEW → CoC-${language}-${String(seq).padStart(3, "0")} (${slot})`;
      subgroup.forEach(p => {
        pSheet.getRange(p.row, pIdx.SuggestedGroup + 1).setValue(groupName);
      });
      // Count suggestions to new groups
      suggestedCount += subgroup.length;
      seq++; // Increment for next group
    });
  });

  // Show summary confirmation
  SpreadsheetApp.getUi().alert(
    `Suggest Groups Summary – ${language}`,
    `Participants considered: ${totalCandidates}\nSuggested: ${suggestedCount}\nCould not be suggested: ${unsuggestedCount}`,
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

/************************************************
 * ACCEPT GROUP SUGGESTIONS
 * - Creates groups
 * - Assigns participants
 * - Sends assignment emails (optional)
 * - Computes member count & coordinator
 ************************************************/
function acceptGroupSuggestions(sendEmails = true) {
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
  const skippedParticipantIDs = [];
  let emailsSent = 0;
  let emailsFailed = 0;
  const errors = [];

  // ============ PASS 1: UPDATE PARTICIPANTS & GROUPS ============
  
  // Count candidates for processing
  const candidateCount = pData.filter(row => 
    row[pIdx.AcceptSuggestion] === true && (row[pIdx.SuggestedGroup] || row[pIdx.AssignedGroup])
  ).length;
  
  if (candidateCount === 0) {
    SpreadsheetApp.getUi().alert(
      'No Suggestions to Accept',
      'No participants have "Accept Suggestion" checked with a suggested group or assigned group.\n\n' +
      'Please:\n' +
      '1. Run "Suggest Groups" for a language OR ensure participants have assigned groups\n' +
      '2. Check the "Accept Suggestion" checkbox for participants you want to process\n' +
      '3. Then run this function again',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
    return;
  }
  
  // Filter and extract group names
  pData.forEach((row, i) => {
    if (row[pIdx.AcceptSuggestion] !== true) return;
    
    // If no suggested group, use assigned group (for re-sending emails)
    // If both are empty, skip this row but clear the checkbox
    if (!row[pIdx.SuggestedGroup] && !row[pIdx.AssignedGroup]) {
      row[pIdx.AcceptSuggestion] = false;
      pData[i] = row;
      skippedParticipantIDs.push(row[pIdx.ParticipantID] || `Row ${i + 2}`);
      return;
    }

    let groupName = "";
    let timing = "";
    let isReassignment = false;

    // If SuggestedGroup is empty, use AssignedGroup (no group change, just email)
    if (!row[pIdx.SuggestedGroup] && row[pIdx.AssignedGroup]) {
      groupName = row[pIdx.AssignedGroup];
      isReassignment = false; // Not changing assignment, just processing for email
    } else {
      // Process SuggestedGroup as before
      isReassignment = true;
      
      const suggested = row[pIdx.SuggestedGroup].trim();
      
      // Pattern a: "NEW → CoC-Tamil-020 (Mon Morning)"
      const newPatternMatch = suggested.match(/NEW\s*→\s*(CoC-[^-]+-\d{3})\s*\(([^)]+)\)/);
      if (newPatternMatch) {
        groupName = newPatternMatch[1];
        timing = newPatternMatch[2];
      } else {
        // Pattern b: "CoC-Tamil-020"
        const directMatch = suggested.match(/CoC-[^-]+-\d{3}/);
        if (directMatch) {
          groupName = directMatch[0];
        } else {
          // Pattern c: Any custom name with optional timing in parentheses
          // e.g., "this-is-a-new-group (Tue evening)" or "CustomGroup"
          const customMatch = suggested.match(/^(.+?)(?:\s*\(([^)]+)\))?$/);
          if (customMatch) {
            groupName = customMatch[1].trim();
            timing = customMatch[2] || "";
          }
        }
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
      newRow[gIdx.GroupCreationDate] = new Date();
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
    if (isReassignment) {
      // Only update assignment if this is a new suggestion
      row[pIdx.AssignedGroup] = groupName;
      row[pIdx.AssignmentStatus] = "Assigned";
      row[pIdx.SuggestedGroup] = "";
    }
    // Always clear the AcceptSuggestion checkbox after processing
    row[pIdx.AcceptSuggestion] = false;
    pData[i] = row;

    // Track ParticipantID for Pass 2 (email sending)
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

  // Log for debugging
  Logger.log(`Starting email send for ${processedParticipantIDs.length} participants`);
  Logger.log(`Participant IDs to process: ${processedParticipantIDs.join(', ')}`);
  Logger.log(`Send emails: ${sendEmails}`);

  // Send emails only for processed participants (if enabled)
  if (sendEmails) {
    processedParticipantIDs.forEach(participantID => {
    try {
      const participantRow = pDataFresh.find(r => r[pIdxFresh.ParticipantID] === participantID);
      if (!participantRow) {
        emailsFailed++;
        errors.push(`❌ ${participantID}: Not found in fresh data after update`);
        return;
      }

      const groupName = participantRow[pIdxFresh.AssignedGroup];
      const groupRow = gDataFresh.find(g => g[gIdxFresh.GroupName] === groupName);
      if (!groupRow) {
        emailsFailed++;
        errors.push(`❌ ${participantID} (${participantRow[pIdxFresh.Name]}): Group "${groupName}" not found`);
        return;
      }

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
      
      emailsSent++;
    } catch (error) {
      emailsFailed++;
      errors.push(`❌ ${participantID}: ${error.message}`);
    }
    });
  }
  
  // Show summary
  let message = `✅ Processed: ${processedParticipantIDs.length}\n`;
  if (skippedParticipantIDs.length > 0) {
    message += `⚠️ Skipped (no group info): ${skippedParticipantIDs.length}\n`;
  }
  if (sendEmails) {
    message += `📧 Emails sent successfully: ${emailsSent}\n`;
  
    if (emailsFailed > 0) {
      message += `❌ Emails failed: ${emailsFailed}\n\n`;
      message += `ERRORS:\n${errors.join('\n')}`;
    }
  } else {
    message += `📧 Emails: Skipped (no email mode)\n`;
  }
  
  // Refresh groups and dashboard after accepting suggestions
  refreshGroupsAndDashboard();

  if (emailsFailed > 0 || errors.length > 0) {
    SpreadsheetApp.getUi().alert('⚠️ Process Completed with Issues', message, SpreadsheetApp.getUi().ButtonSet.OK);
  } else {
    SpreadsheetApp.getUi().alert('✅ Success', message, SpreadsheetApp.getUi().ButtonSet.OK);
  }
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
      newRow[gIdx.GroupCreationDate] = new Date();
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
  const groupsMetrics = [
    { key: "ActiveGroups", label: "Active Groups" },
    { key: "InactiveGroups", label: "Inactive Groups", highlight: true },
    { key: "NoCoordinator", label: "Groups without Coordinator", highlight: true },
    { key: "CompletedGroups", label: "Completed Groups" },
    { key: "ClosedGroups", label: "Closed Groups" },
    { key: "TerminatedGroups", label: "Terminated Groups" }
  ];
  
  const participantsMetrics = [
    { key: "Unassigned", label: "Unassigned Participants" },
    { key: "Assigned", label: "Assigned Participants" },
    { key: "Active", label: "Active Participants" },
    { key: "Inactive", label: "Inactive Participants", highlight: true },
    { key: "Discontinued", label: "Discontinued Participants" },
    { key: "Completed", label: "Completed Participants" }
  ];

  // Clear entire sheet content and format
  const maxRows = d.getMaxRows();
  const maxCols = d.getMaxColumns();
  d.getRange(1, 1, maxRows, maxCols).clearContent();
  d.getRange(1, 1, maxRows, maxCols).clearFormat();

  // Add column headers at row 1 (Metric + languages)
  d.getRange(1, 1, 1, 6).setValues([["Metric", "English", "Tamil", "Hindi", "Kannada", "Telugu"]]);
  d.getRange(1, 1, 1, 6).setFontWeight("bold").setBackground("#D3D3D3").setHorizontalAlignment("center");

  let row = 2;
  const sectionFill = "#6C8EBF";  // Soft blue/grey for section headers
  const highlightFill = "#FDE2E2"; // Very light red for action items
  const sectionFontColor = "#FFFFFF";
  const highlightFontColor = "#000000";

  // Groups section
  d.getRange(row, 1, 1, 6).setValues([["GROUPS", "", "", "", "", ""]]);
  d.getRange(row, 1).setFontColor(sectionFontColor).setBackground(sectionFill).setFontWeight("bold");
  row++;

  // Group metrics
  groupsMetrics.forEach(m => {
    d.getRange(row, 1).setValue(m.label);
    let shouldHighlightLabel = false;
    const rowValues = [];
    langs.forEach((l, j) => {
      let v = 0;
      if (m.key === "ActiveGroups") {
        v = g.filter(r => r[gIdx.Language] === l && r[gIdx.Status] === "Active").length;
      } else if (m.key === "InactiveGroups") {
        v = g.filter(r => r[gIdx.Language] === l && r[gIdx.Status] === "Inactive").length;
      } else if (m.key === "CompletedGroups") {
        v = g.filter(r => r[gIdx.Language] === l && r[gIdx.Status] === "Completed").length;
      } else if (m.key === "ClosedGroups") {
        v = g.filter(r => r[gIdx.Language] === l && r[gIdx.Status] === "Closed").length;
      } else if (m.key === "TerminatedGroups") {
        v = g.filter(r => r[gIdx.Language] === l && r[gIdx.Status] === "Terminated").length;
      } else if (m.key === "NoCoordinator") {
        v = g.filter(r => r[gIdx.Language] === l && !r[gIdx.CoordinatorEmail]).length;
      }
      rowValues[j] = v;
      d.getRange(row, j + 2).setValue(v);
    });

    // Apply highlight only where action is needed (non-zero values)
    if (m.highlight) {
      rowValues.forEach((v, idx) => {
        if (v > 0) {
          shouldHighlightLabel = true;
          d.getRange(row, idx + 2).setBackground(highlightFill).setFontColor(highlightFontColor).setFontWeight("bold");
        }
      });
      if (shouldHighlightLabel) {
        d.getRange(row, 1).setBackground(highlightFill).setFontColor(highlightFontColor).setFontWeight("bold");
      }
    }
    row++;
  });

  row++; // Blank row

  // Participants section
  d.getRange(row, 1, 1, 6).setValues([["PARTICIPANTS", "", "", "", "", ""]]);
  d.getRange(row, 1).setFontColor(sectionFontColor).setBackground(sectionFill).setFontWeight("bold");
  row++;

  // Participant metrics
  participantsMetrics.forEach(m => {
    d.getRange(row, 1).setValue(m.label);
    let shouldHighlightLabel = false;
    const rowValues = [];
    langs.forEach((l, j) => {
      let v = 0;
      if (m.key === "Unassigned") {
        v = p.filter(r => r[pIdx.Language] === l && r[pIdx.AssignmentStatus] === "Unassigned").length;
      } else if (m.key === "Assigned") {
        v = p.filter(r => r[pIdx.Language] === l && r[pIdx.AssignmentStatus] === "Assigned").length;
      } else if (m.key === "Active") {
        v = p.filter(r => r[pIdx.Language] === l && r[pIdx.AssignmentStatus] === "Assigned" && r[pIdx.IsActive] === true).length;
      } else if (m.key === "Inactive") {
        v = p.filter(r => r[pIdx.Language] === l && r[pIdx.IsActive] === false && r[pIdx.AssignmentStatus] !== "Discontinued" && r[pIdx.AssignmentStatus] !== "Completed").length;
      } else if (m.key === "Discontinued") {
        v = p.filter(r => r[pIdx.Language] === l && r[pIdx.AssignmentStatus] === "Discontinued").length;
      } else if (m.key === "Completed") {
        v = p.filter(r => r[pIdx.Language] === l && r[pIdx.AssignmentStatus] === "Completed").length;
      }
      rowValues[j] = v;
      d.getRange(row, j + 2).setValue(v);
    });

    // Apply highlight only where action is needed (non-zero values)
    if (m.highlight) {
      rowValues.forEach((v, idx) => {
        if (v > 0) {
          shouldHighlightLabel = true;
          d.getRange(row, idx + 2).setBackground(highlightFill).setFontColor(highlightFontColor).setFontWeight("bold");
        }
      });
      if (shouldHighlightLabel) {
        d.getRange(row, 1).setBackground(highlightFill).setFontColor(highlightFontColor).setFontWeight("bold");
      }
    }
    row++;
  });

  // Center align numeric values across language columns
  const lastDataRow = row - 1;
  if (lastDataRow >= 2) {
    d.getRange(2, 2, lastDataRow - 1, 5).setHorizontalAlignment("center");
  }
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
  if (!email || !email.trim()) {
    throw new Error(`Invalid email address for ${name}`);
  }
  
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
    <br>
    <p><strong>${labels.resourcesTitle}</strong></p>
    <p><strong>${labels.cocOverview}</strong> - <a href="https://drive.google.com/file/d/1tqpRafvnAnHK9DHa89iMkbQSiFb7N10Z/view?usp=drive_link">https://drive.google.com/file/d/1tqpRafvnAnHK9DHa89iMkbQSiFb7N10Z/view?usp=drive_link</a></p>
    <p><strong>${labels.cocSchedule}</strong> - <a href="https://docs.google.com/document/d/1vBFe13jNDRNRZgBYCN0Z8eUzmsn1IPM_IMQlIvkPHVE/edit?usp=drive_link">https://docs.google.com/document/d/1vBFe13jNDRNRZgBYCN0Z8eUzmsn1IPM_IMQlIvkPHVE/edit?usp=drive_link</a></p>
    <p><strong>${labels.downloadableBooks}</strong> - <a href="https://drive.google.com/drive/folders/1YBA3bXMdivoN3oPslCK5gBw_chjPRDYQ?usp=drive_link">https://drive.google.com/drive/folders/1YBA3bXMdivoN3oPslCK5gBw_chjPRDYQ?usp=drive_link</a></p>
    <p><strong>${labels.nvcBook}</strong><br>
    ${labels.bookPurchase} <a href="https://www.flipkart.com/nonviolent-communication/p/itma4a783fae0a37?pid=9789382400295">https://www.flipkart.com/nonviolent-communication/p/itma4a783fae0a37?pid=9789382400295</a></p>
    <br>
    <p>${labels.whatsappNote}</p>
    <br>
    <p>${labels.regards}</p>
  `;
  
  try {
    const emailOptions = {
      to: email,
      subject: subject,
      htmlBody: htmlBody
    };
    
    // Add coordinator as CC if available
    if (groupInfo.coordinatorEmail && groupInfo.coordinatorEmail.trim()) {
      emailOptions.cc = groupInfo.coordinatorEmail;
    }
    
    MailApp.sendEmail(emailOptions);
  } catch (error) {
    throw new Error(`Email sending failed for ${email}: ${error.message}`);
  }
}

function sendCoordinatorAssignmentEmail(email, name, language, groupInfo, members) {
  if (!email || !email.trim()) {
    throw new Error(`Invalid email address for coordinator ${name}`);
  }
  
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
    <br>
    <p>${labels.coordinatorUpdate} <a href="https://www.hcessentials.org/coc-coordinator-update">https://www.hcessentials.org/coc-coordinator-update</a></p>
    <br>
    <p><strong>${labels.nextSteps}</strong></p>
    <ol>
      <li>${labels.createWhatsApp}</li>
      <li>${labels.shareResources}
        <ul style="margin-top: 10px;">
          <li><strong>${labels.cocOverview}</strong> - <a href="https://drive.google.com/file/d/1tqpRafvnAnHK9DHa89iMkbQSiFb7N10Z/view?usp=drive_link">https://drive.google.com/file/d/1tqpRafvnAnHK9DHa89iMkbQSiFb7N10Z/view?usp=drive_link</a></li>
          <li><strong>${labels.cocSchedule}</strong> - <a href="https://docs.google.com/document/d/1vBFe13jNDRNRZgBYCN0Z8eUzmsn1IPM_IMQlIvkPHVE/edit?usp=drive_link">https://docs.google.com/document/d/1vBFe13jNDRNRZgBYCN0Z8eUzmsn1IPM_IMQlIvkPHVE/edit?usp=drive_link</a></li>
          <li><strong>${labels.downloadableBooks}</strong> - <a href="https://drive.google.com/drive/folders/1YBA3bXMdivoN3oPslCK5gBw_chjPRDYQ?usp=drive_link">https://drive.google.com/drive/folders/1YBA3bXMdivoN3oPslCK5gBw_chjPRDYQ?usp=drive_link</a></li>
          <li><strong>${labels.nvcBook}</strong><br>
          ${labels.bookPurchase} <a href="https://www.flipkart.com/nonviolent-communication/p/itma4a783fae0a37?pid=9789382400295">https://www.flipkart.com/nonviolent-communication/p/itma4a783fae0a37?pid=9789382400295</a></li>
        </ul>
      </li>
      <li>${labels.inviteMembers}</li>
    </ol>
    <br>
    <p>${labels.regards}</p>
  `;
  
  try {
    MailApp.sendEmail({
      to: email,
      subject: subject,
      htmlBody: htmlBody
    });
  } catch (error) {
    throw new Error(`Email sending failed for coordinator ${email}: ${error.message}`);
  }
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
      regards: "Best regards,<br>CoC Team",
      resourcesTitle: "Please refer to the following documents for information:",
      cocOverview: "CoC Overview",
      cocSchedule: "CoC Weekly Schedule and Study Materials",
      downloadableBooks: "Tamil and English Downloadable Books (link valid for 3 days only)",
      nvcBook: "Nonviolent Communication: A Language of Life (3rd Edition):",
      bookPurchase: "Book can be purchased at:",
      whatsappNote: "Your Coordinator will add you to your CoC WhatsApp group within a day or two. If you have not been added, you may directly reach out to your coordinator whose contact details are above.",
      nextSteps: "Next Steps:",
      createWhatsApp: "Please create a WhatsApp group for your CoC Study Group with the above members within a day or two.",
      shareResources: "Share the following details in the WhatsApp Group's description:",
      inviteMembers: "Invite the members to an initial meeting over Zoom or Google Meet.",
      coordinatorUpdate: "Submit the Coordinator's update for after each weekly session:"
    },
    Tamil: {
      memberSubject: "CoC குழு ஒதுக்கீடு உறுதிப்படுத்தல்",
      memberIntro: "நீங்கள் CoC படிப்பு குழுவில் சேர்க்கப்பட்டுள்ளீர்கள்!",
      coordinatorSubject: "CoC குழு ஒருங்கிணைப்பாளர் நியமனம்",
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
      regards: "நன்றி,<br>CoC குழு",
      resourcesTitle: "தகவலுக்கு பின்வரும் ஆவணங்களைப் பார்க்கவும்:",
      cocOverview: "CoC கண்ணோட்டம்",
      cocSchedule: "CoC வாராந்திர அட்டவணை மற்றும் படிப்புப் பொருட்கள்",
      downloadableBooks: "தமிழ் மற்றும் ஆங்கில பதிவிறக்கம் செய்யக்கூடிய புத்தகங்கள் (இணைப்பு 3 நாட்களுக்கு மட்டுமே செல்லுபடியாகும்)",
      nvcBook: "அகிம்சை தொடர்பு: வாழ்க்கையின் மொழி (3வது பதிப்பு) ஆங்கிலம் :",
      bookPurchase: "புத்தகத்தை வாங்க:",
      whatsappNote: "உங்கள் ஒருங்கிணைப்பாளர் ஒரு அல்லது இரண்டு நாட்களுக்குள் உங்களை CoC வாட்ஸ்அப் குழுவில் சேர்ப்பார். நீங்கள் சேர்க்கப்படவில்லை என்றால், மேலே உள்ள தொடர்பு விவரங்களைப் பயன்படுத்தி நேரடியாக உங்கள் ஒருங்கிணைப்பாளரைத் தொடர்பு கொள்ளலாம்.",
      nextSteps: "அடுத்த படிகள்:",
      createWhatsApp: "ஓன்று அல்லது இரண்டு நாட்களுக்குள் மேலே உள்ள உறுப்பினர்களுடன் உங்கள் CoC படிப்பு குழுவிற்கான வாட்ஸ்அப் குழுவை உருவாக்கவும்.",
      shareResources: "வாட்ஸ்அப் குழுவின் Description-ல் பின்வரும் விவரங்களைப் பகிரவும்:",
      inviteMembers: "Zoom அல்லது Google Meet மூலம் உறுப்பினர்களை ஆரம்ப சந்திப்பிற்கு அழைக்கவும்.",
      coordinatorUpdate: "ஒவ்வொரு வாராந்திர அமர்வுக்குப் பிறகு ஒருங்கிணைப்பாளரின் மேம்பாட்டை சமர்ப்பிக்கவும்:"
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
      regards: "सादर,<br>CoC टीम",
      resourcesTitle: "जानकारी के लिए कृपया निम्नलिखित दस्तावेज़ देखें:",
      cocOverview: "CoC अवलोकन",
      cocSchedule: "CoC साप्ताहिक कार्यक्रम और अध्ययन सामग्री",
      downloadableBooks: "तमिल और अंग्रेजी डाउनलोड करने योग्य पुस्तकें (लिंक केवल 3 दिनों के लिए मान्य)",
      nvcBook: "अहिंसक संचार: जीवन की भाषा (तीसरा संस्करण):",
      bookPurchase: "पुस्तक यहाँ से खरीदी जा सकती है:",
      whatsappNote: "आपके समन्वयक एक या दो दिन में आपको CoC व्हाट्सएप समूह में जोड़ेंगे। यदि आपको नहीं जोड़ा गया है, तो आप ऊपर दिए गए संपर्क विवरण का उपयोग करके सीधे अपने समन्वयक से संपर्क कर सकते हैं।",
      nextSteps: "अगले कदम:",
      createWhatsApp: "कृपया एक या दो दिन के भीतर उपरोक्त सदस्यों के साथ अपने CoC अध्ययन समूह के लिए एक व्हाट्सएप समूह बनाएं।",
      shareResources: "व्हाट्सएप समूह के विवरण में निम्नलिखित जानकारी साझा करें:",
      inviteMembers: "Zoom या Google Meet के माध्यम से सदस्यों को प्रारंभिक बैठक के लिए आमंत्रित करें।",
      coordinatorUpdate: "प्रत्येक साप्ताहिक सत्र के बाद समन्वयक की अपडेट जमा करें:"
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
      regards: "ಧನ್ಯವಾದಗಳು,<br>CoC ತಂಡ",
      resourcesTitle: "ಮಾಹಿತಿಗಾಗಿ ದಯವಿಟ್ಟು ಈ ಕೆಳಗಿನ ದಾಖಲೆಗಳನ್ನು ನೋಡಿ:",
      cocOverview: "CoC ಅವಲೋಕನ",
      cocSchedule: "CoC ವಾರಾಂತ್ಯ ವೇಳಾಪಟ್ಟಿ ಮತ್ತು ಅಧ್ಯಯನ ಸಾಮಗ್ರಿಗಳು",
      downloadableBooks: "ತಮಿಳು ಮತ್ತು ಇಂಗ್ಲಿಷ್ ಡೌನ್‌ಲೋಡ್ ಮಾಡಬಹುದಾದ ಪುಸ್ತಕಗಳು (ಲಿಂಕ್ ಕೇವಲ 3 ದಿನಗಳವರೆಗೆ ಮಾತ್ರ ಮಾನ್ಯ)",
      nvcBook: "ಅಹಿಂಸಾ ಸಂವಹನ: ಜೀವನದ ಭಾಷೆ (3ನೇ ಆವೃತ್ತಿ):",
      bookPurchase: "ಪುಸ್ತಕವನ್ನು ಇಲ್ಲಿ ಖರೀದಿಸಬಹುದು:",
      whatsappNote: "ನಿಮ್ಮ ಸಮನ್ವಯಕರು ಒಂದು ಅಥವಾ ಎರಡು ದಿನಗಳಲ್ಲಿ ನಿಮ್ಮನ್ನು CoC ವಾಟ್ಸಾಪ್ ಗುಂಪಿಗೆ ಸೇರಿಸುತ್ತಾರೆ. ನೀವು ಸೇರಿಸದಿದ್ದರೆ, ಮೇಲೆ ನೀಡಲಾದ ಸಂಪರ್ಕ ವಿವರಗಳನ್ನು ಬಳಸಿಕೊಂಡು ನೀವು ನೇರವಾಗಿ ನಿಮ್ಮ ಸಮನ್ವಯಕರನ್ನು ಸಂಪರ್ಕಿಸಬಹುದು.",
      nextSteps: "ಮುಂದಿನ ಹಂತಗಳು:",
      createWhatsApp: "ದಯವಿಟ್ಟು ಒಂದು ಅಥವಾ ಎರಡು ದಿನಗಳಲ್ಲಿ ಮೇಲಿನ ಸದಸ್ಯರೊಂದಿಗೆ ನಿಮ್ಮ CoC ಅಧ್ಯಯನ ಗುಂಪಿಗೆ ವಾಟ್ಸಾಪ್ ಗುಂಪನ್ನು ರಚಿಸಿ.",
      shareResources: "ವಾಟ್ಸಾಪ್ ಗುಂಪಿನ ವಿವರಣೆಯಲ್ಲಿ ಈ ಕೆಳಗಿನ ವಿವರಗಳನ್ನು ಹಂಚಿಕೊಳ್ಳಿ:",
      inviteMembers: "Zoom ಅಥವಾ Google Meet ಮೂಲಕ ಸದಸ್ಯರನ್ನು ಆರಂಭಿಕ ಸಭೆಗೆ ಆಹ್ವಾನಿಸಿ.",
      coordinatorUpdate: "ಪ್ರತಿ ವಾರದ ಅಧಿವೇಶನದ ನಂತರ ಸಮನ್ವಯಕರ ಅಪ್‌ಡೇಟ್ ಸಲ್ಲಿಸಿ:"
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
      regards: "శుభాకాంక్షలు,<br>CoC బృందం",
      resourcesTitle: "సమాచారం కోసం దయచేసి క్రింది పత్రాలను చూడండి:",
      cocOverview: "CoC అవలోకనం",
      cocSchedule: "CoC వారపు షెడ్యూల్ మరియు అధ్యయన పత్రాలు",
      downloadableBooks: "తమిళం మరియు ఇంగ్లీష్ డౌన్‌లోడ్ చేయదగిన పుస్తకాలు (లింక్ 3 రోజులకు మాత్రమే చెల్లుతుంది)",
      nvcBook: "అహింసా సంభాషణ: జీవితం యొక్క భాష (3వ ఎడిషన్):",
      bookPurchase: "పుస్తకాన్ని ఇక్కడ కొనుగోలు చేయవచ్చు:",
      whatsappNote: "మీ సమన్వయకర్త ఒకటి లేదా రెండు రోజుల్లో మిమ్మల్ని CoC వాట్సాప్ సమూహంలో చేర్చుతారు. మీరు చేర్చబడకపోతే, పైన ఇచ్చిన సంప్రదింపు వివరాలను ఉపయోగించి మీరు నేరుగా మీ సమన్వయకర్తను సంప్రదించవచ్చు.",
      nextSteps: "తదుపరి దశలు:",
      createWhatsApp: "దయచేసి ఒకటి లేదా రెండు రోజుల్లో పై సభ్యులతో మీ CoC అధ్యయన సమూహానికి వాట్సాప్ సమూహాన్ని సృష్టించండి.",
      shareResources: "వాట్సాప్ సమూహ వివరణలో క్రింది వివరాలను భాగస్వామ్యం చేయండి:",
      inviteMembers: "Zoom లేదా Google Meet ద్వారా సభ్యులను ప్రారంభ సమావేశానికి ఆహ్వానించండి.",
      coordinatorUpdate: "ప్రతి వారపు సెషన్ తర్వాత సమన్వయకర్త యొక్క అపడేట్ సమర్పించండి:"
    }
  };
  
  return allLabels[language] || allLabels.English;
}

function getLifecycleEmailLabels(language) {
  const allLabels = {
    English: {
      closedSubject: "CoC Group Closed - {groupName}",
      closedBodyActive: "Dear {name},\n\nYour CoC group ({groupName}) is now closed as you have completed all sessions. Congratulations on successfully completing your CoC journey! If you would like to repeat with a new group, please register again at {regLink}.\n\nWith best wishes,\nCoC Admin Team",
      closedBodyInactive: "Dear {name},\n\nYour CoC group ({groupName}) is now closed as the group has completed all sessions. We understand you may have had other commitments or personal situations. If you would like to continue your CoC journey in the future, please register at {regLink}.\n\nWith best wishes,\nCoC Admin Team",
      terminatedSubject: "CoC Group Terminated - {groupName}",
      terminatedBody: "Dear {name},\n\nYour CoC group ({groupName}) has been dissolved as it has not been functioning. We acknowledge your efforts and encourage you to register again at {regLink} if you would like to continue your CoC journey with a new group.\n\nWith best wishes,\nCoC Admin Team",
      discontinuedSubject: "CoC Participation Discontinued - {groupName}",
      discontinuedBody: "Dear {name},\n\nWe have removed your name from the CoC group ({groupName}) as you have not been joining sessions. We understand you may have other commitments or personal situations. If you would like to continue your CoC journey in the future, please register at {regLink}.\n\nWith best wishes,\nCoC Admin Team"
    },
    Tamil: {
      closedSubject: "CoC குழு மூடப்பட்டது - {groupName}",
      closedBodyActive: "அன்புள்ள {name},\n\nநீங்கள் அனைத்து அமர்வுகளையும் முடித்துவிட்டதால் உங்கள் CoC குழு ({groupName}) இப்போது மூடப்பட்டுள்ளது. உங்கள் CoC பயணத்தை வெற்றிகரமாக முடித்ததற்கு வாழ்த்துக்கள்! நீங்கள் புதிய குழுவுடன் மீண்டும் செய்ய விரும்பினால், {regLink} இல் மீண்டும் பதிவு செய்யவும்.\n\nநல்வாழ்த்துகளுடன்,\nCoC நிர்வாகக் குழு",
      closedBodyInactive: "அன்புள்ள {name},\n\nகுழு அனைத்து அமர்வுகளையும் முடித்துவிட்டதால் உங்கள் CoC குழு ({groupName}) இப்போது மூடப்பட்டுள்ளது. உங்களுக்கு வேறு கடமைகள் அல்லது தனிப்பட்ட சூழ்நிலைகள் இருந்திருக்கலாம் என்பதை நாங்கள் புரிந்துகொள்கிறோம். எதிர்காலத்தில் உங்கள் CoC பயணத்தைத் தொடர விரும்பினால், {regLink} இல் பதிவு செய்யவும்.\n\nநல்வாழ்த்துகளுடன்,\nCoC நிர்வாகக் குழு",
      terminatedSubject: "CoC குழு கலைக்கப்பட்டது - {groupName}",
      terminatedBody: "அன்புள்ள {name},\n\nஉங்கள் CoC குழு ({groupName}) செயல்படவில்லை என்பதால் கலைக்கப்பட்டுள்ளது. உங்கள் முயற்சிகளை நாங்கள் அங்கீகரிக்கிறோம், புதிய குழுவுடன் உங்கள் CoC பயணத்தைத் தொடர விரும்பினால் {regLink} இல் மீண்டும் பதிவு செய்ய ஊக்குவிக்கிறோம்.\n\nநல்வாழ்த்துகளுடன்,\nCoC நிர்வாகக் குழு",
      discontinuedSubject: "CoC பங்கேற்பு நிறுத்தப்பட்டது - {groupName}",
      discontinuedBody: "அன்புள்ள {name},\n\nநீங்கள் அமர்வுகளில் கலந்து கொள்ளாததால் உங்கள் பெயரை CoC குழுவிலிருந்து ({groupName}) அகற்றிவிட்டோம். உங்களுக்கு வேறு கடமைகள் அல்லது தனிப்பட்ட சூழ்நிலைகள் இருக்கலாம் என்பதை நாங்கள் புரிந்துகொள்கிறோம். எதிர்காலத்தில் உங்கள் CoC பயணத்தைத் தொடர விரும்பினால், {regLink} இல் பதிவு செய்யவும்.\n\nநல்வாழ்த்துகளுடன்,\nCoC நிர்வாகக் குழு"
    },
    Hindi: {
      closedSubject: "CoC समूह बंद - {groupName}",
      closedBodyActive: "प्रिय {name},\n\nआपका CoC समूह ({groupName}) अब बंद हो गया है क्योंकि आपने सभी सत्र पूरे कर लिए हैं। अपनी CoC यात्रा को सफलतापूर्वक पूरा करने के लिए बधाई! यदि आप एक नए समूह के साथ दोहराना चाहते हैं, तो कृपया {regLink} पर फिर से पंजीकरण करें।\n\nशुभकामनाओं के साथ,\nCoC प्रशासन टीम",
      closedBodyInactive: "प्रिय {name},\n\nआपका CoC समूह ({groupName}) अब बंद हो गया है क्योंकि समूह ने सभी सत्र पूरे कर लिए हैं। हम समझते हैं कि आपकी अन्य प्रतिबद्धताएँ या व्यक्तिगत परिस्थितियाँ हो सकती हैं। यदि आप भविष्य में अपनी CoC यात्रा जारी रखना चाहते हैं, तो कृपया {regLink} पर पंजीकरण करें।\n\nशुभकामनाओं के साथ,\nCoC प्रशासन टीम",
      terminatedSubject: "CoC समूह समाप्त - {groupName}",
      terminatedBody: "प्रिय {name},\n\nआपका CoC समूह ({groupName}) भंग कर दिया गया है क्योंकि यह कार्य नहीं कर रहा था। हम आपके प्रयासों को स्वीकार करते हैं और यदि आप एक नए समूह के साथ अपनी CoC यात्रा जारी रखना चाहते हैं तो {regLink} पर फिर से पंजीकरण करने के लिए प्रोत्साहित करते हैं।\n\nशुभकामनाओं के साथ,\nCoC प्रशासन टीम",
      discontinuedSubject: "CoC भागीदारी बंद - {groupName}",
      discontinuedBody: "प्रिय {name},\n\nहमने CoC समूह ({groupName}) से आपका नाम हटा दिया है क्योंकि आप सत्रों में शामिल नहीं हो रहे थे। हम समझते हैं कि आपकी अन्य प्रतिबद्धताएँ या व्यक्तिगत परिस्थितियाँ हो सकती हैं। यदि आप भविष्य में अपनी CoC यात्रा जारी रखना चाहते हैं, तो कृपया {regLink} पर पंजीकरण करें।\n\nशुभकामनाओं के साथ,\nCoC प्रशासन टीम"
    },
    Kannada: {
      closedSubject: "CoC ಗುಂಪು ಮುಚ್ಚಲಾಗಿದೆ - {groupName}",
      closedBodyActive: "ಆತ್ಮೀಯ {name},\n\nನೀವು ಎಲ್ಲಾ ಅಧಿವೇಶನಗಳನ್ನು ಪೂರ್ಣಗೊಳಿಸಿದ್ದರಿಂದ ನಿಮ್ಮ CoC ಗುಂಪು ({groupName}) ಈಗ ಮುಚ್ಚಲಾಗಿದೆ. ನಿಮ್ಮ CoC ಪ್ರಯಾಣವನ್ನು ಯಶಸ್ವಿಯಾಗಿ ಪೂರ್ಣಗೊಳಿಸಿದ್ದಕ್ಕಾಗಿ ಅಭಿನಂದನೆಗಳು! ನೀವು ಹೊಸ ಗುಂಪಿನೊಂದಿಗೆ ಪುನರಾವರ್ತಿಸಲು ಬಯಸಿದರೆ, ದಯವಿಟ್ಟು {regLink} ನಲ್ಲಿ ಮತ್ತೆ ನೋಂದಾಯಿಸಿ.\n\nಶುಭಾಶಯಗಳೊಂದಿಗೆ,\nCoC ನಿರ್ವಹಣಾ ತಂಡ",
      closedBodyInactive: "ಆತ್ಮೀಯ {name},\n\nಗುಂಪು ಎಲ್ಲಾ ಅಧಿವೇಶನಗಳನ್ನು ಪೂರ್ಣಗೊಳಿಸಿದ್ದರಿಂದ ನಿಮ್ಮ CoC ಗುಂಪು ({groupName}) ಈಗ ಮುಚ್ಚಲಾಗಿದೆ. ನೀವು ಇತರ ಬದ್ಧತೆಗಳು ಅಥವಾ ವೈಯಕ್ತಿಕ ಸನ್ನಿವೇಶಗಳನ್ನು ಹೊಂದಿರಬಹುದು ಎಂದು ನಾವು ಅರ್ಥಮಾಡಿಕೊಳ್ಳುತ್ತೇವೆ. ಭವಿಷ್ಯದಲ್ಲಿ ನಿಮ್ಮ CoC ಪ್ರಯಾಣವನ್ನು ಮುಂದುವರಿಸಲು ಬಯಸಿದರೆ, ದಯವಿಟ್ಟು {regLink} ನಲ್ಲಿ ನೋಂದಾಯಿಸಿ.\n\nಶುಭಾಶಯಗಳೊಂದಿಗೆ,\nCoC ನಿರ್ವಹಣಾ ತಂಡ",
      terminatedSubject: "CoC ಗುಂಪು ವಿಸರ್ಜಿಸಲಾಗಿದೆ - {groupName}",
      terminatedBody: "ಆತ್ಮೀಯ {name},\n\nನಿಮ್ಮ CoC ಗುಂಪು ({groupName}) ಕಾರ್ಯನಿರ್ವಹಿಸುತ್ತಿಲ್ಲದ ಕಾರಣ ವಿಸರ್ಜಿಸಲಾಗಿದೆ. ನಾವು ನಿಮ್ಮ ಪ್ರಯತ್ನಗಳನ್ನು ಅಂಗೀಕರಿಸುತ್ತೇವೆ ಮತ್ತು ನೀವು ಹೊಸ ಗುಂಪಿನೊಂದಿಗೆ ನಿಮ್ಮ CoC ಪ್ರಯಾಣವನ್ನು ಮುಂದುವರಿಸಲು ಬಯಸಿದರೆ {regLink} ನಲ್ಲಿ ಮತ್ತೆ ನೋಂದಾಯಿಸಲು ಪ್ರೋತ್ಸಾಹಿಸುತ್ತೇವೆ.\n\nಶುಭಾಶಯಗಳೊಂದಿಗೆ,\nCoC ನಿರ್ವಹಣಾ ತಂಡ",
      discontinuedSubject: "CoC ಭಾಗವಹಿಸುವಿಕೆ ನಿಲ್ಲಿಸಲಾಗಿದೆ - {groupName}",
      discontinuedBody: "ಆತ್ಮೀಯ {name},\n\nನೀವು ಅಧಿವೇಶನಗಳಿಗೆ ಸೇರದ ಕಾರಣ ನಾವು CoC ಗುಂಪಿನಿಂದ ({groupName}) ನಿಮ್ಮ ಹೆಸರನ್ನು ತೆಗೆದುಹಾಕಿದ್ದೇವೆ. ನೀವು ಇತರ ಬದ್ಧತೆಗಳು ಅಥವಾ ವೈಯಕ್ತಿಕ ಸನ್ನಿವೇಶಗಳನ್ನು ಹೊಂದಿರಬಹುದು ಎಂದು ನಾವು ಅರ್ಥಮಾಡಿಕೊಳ್ಳುತ್ತೇವೆ. ಭವಿಷ್ಯದಲ್ಲಿ ನಿಮ್ಮ CoC ಪ್ರಯಾಣವನ್ನು ಮುಂದುವರಿಸಲು ಬಯಸಿದರೆ, ದಯವಿಟ್ಟು {regLink} ನಲ್ಲಿ ನೋಂದಾಯಿಸಿ.\n\nಶುಭಾಶಯಗಳೊಂದಿಗೆ,\nCoC ನಿರ್ವಹಣಾ ತಂಡ"
    },
    Telugu: {
      closedSubject: "CoC గ్రూప్ మూసివేయబడింది - {groupName}",
      closedBodyActive: "ప్రియమైన {name},\n\nమీరు అన్ని సెషన్‌లను పూర్తి చేసినందున మీ CoC గ్రూప్ ({groupName}) ఇప్పుడు మూసివేయబడింది. మీ CoC ప్రయాణాన్ని విజయవంతంగా పూర్తి చేసినందుకు అభినందనలు! మీరు కొత్త గ్రూప్‌తో పునరావృతం చేయాలనుకుంటే, దయచేసి {regLink} వద్ద మళ్లీ నమోదు చేయండి.\n\nశుభాకాంక్షలతో,\nCoC నిర్వహణ బృందం",
      closedBodyInactive: "ప్రియమైన {name},\n\nగ్రూప్ అన్ని సెషన్‌లను పూర్తి చేసినందున మీ CoC గ్రూప్ ({groupName}) ఇప్పుడు మూసివేయబడింది. మీకు ఇతర బాధ్యతలు లేదా వ్యక్తిగత పరిస్థితులు ఉండవచ్చని మేము అర్థం చేసుకుంటున్నాము. భవిష్యత్తులో మీ CoC ప్రయాణాన్ని కొనసాగించాలనుకుంటే, దయచేసి {regLink} వద్ద నమోదు చేయండి.\n\nశుభాకాంక్షలతో,\nCoC నిర్వహణ బృందం",
      terminatedSubject: "CoC గ్రూప్ రద్దు చేయబడింది - {groupName}",
      terminatedBody: "ప్రియమైన {name},\n\nమీ CoC గ్రూప్ ({groupName}) పనిచేయడం లేదు కాబట్టి రద్దు చేయబడింది. మేము మీ ప్రయత్నాలను గుర్తిస్తున్నాము మరియు మీరు కొత్త గ్రూప్‌తో మీ CoC ప్రయాణాన్ని కొనసాగించాలనుకుంటే {regLink} వద్ద మళ్లీ నమోదు చేయమని ప్రోత్సహిస్తున్నాము.\n\nశుభాకాంక్షలతో,\nCoC నిర్వహణ బృందం",
      discontinuedSubject: "CoC భాగస్వామ్యం నిలిపివేయబడింది - {groupName}",
      discontinuedBody: "ప్రియమైన {name},\n\nమీరు సెషన్‌లలో చేరడం లేదు కాబట్టి మేము CoC గ్రూప్ ({groupName}) నుండి మీ పేరును తొలగించాము. మీకు ఇతర బాధ్యతలు లేదా వ్యక్తిగత పరిస్థితులు ఉండవచ్చని మేము అర్థం చేసుకుంటున్నాము. భవిష్యత్తులో మీ CoC ప్రయాణాన్ని కొనసాగించాలనుకుంటే, దయచేసి {regLink} వద్ద నమోదు చేయండి.\n\nశుభాకాంక్షలతో,\nCoC నిర్వహణ బృందం"
    }
  };
  
  return allLabels[language] || allLabels.English;
}
