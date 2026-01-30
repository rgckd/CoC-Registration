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
    .addItem("Accept Suggestions and Email", "acceptGroupSuggestions")
    .addItem("Accept Suggestions Without Email", "acceptGroupSuggestionsNoEmail")
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
    newRow[tIdx.Suggestions] = "";
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

/**
 * ADMIN EMAIL LOOKUP (from MASTER sheet)
 * Reads the row with RecordType = "AdminEmail" in the MASTER sheet and
 * returns a map of { LanguageName -> adminEmail } based on language headers.
 */
function getAdminEmailMapFromMaster() {
  const ss = SpreadsheetApp.getActive();
  const master = ss.getSheetByName("MASTER");
  if (!master) {
    Logger.log("MASTER sheet not found. Admin emails cannot be resolved.");
    return {};
  }
  const data = master.getDataRange().getValues();
  if (!data || data.length < 2) return {};

  const headers = data[0].map(h => String(h || "").trim());
  const recordRow = data.find(r => String(r[0] || "").trim().toLowerCase() === "adminemail");
  if (!recordRow) return {};

  // Try to detect the first language column (defaults to index 2: column C)
  let langStartIdx = headers.findIndex(h => h.toLowerCase() === "english");
  if (langStartIdx < 0) langStartIdx = 2;

  const map = {};
  for (let c = langStartIdx; c < headers.length; c++) {
    const lang = headers[c];
    if (!lang) continue;
    const email = String(recordRow[c] || "").trim();
    if (email) map[lang] = email;
  }
  return map;
}

function getAdminEmailForLanguage(language) {
  const map = getAdminEmailMapFromMaster();
  const want = String(language || "").trim().toLowerCase();
  const key = Object.keys(map).find(k => k.toLowerCase() === want);
  return key ? map[key] : "";
}

// Quick verification helper to inspect resolved admin emails in logs
function debugLogAdminEmails() {
  const map = getAdminEmailMapFromMaster();
  Object.keys(map).forEach(k => Logger.log(`${k} -> ${map[k]}`));
}

/**
 * RESOURCE LINKS LOOKUP (from MASTER sheet)
 * Returns language-specific links for CoC Overview, Weekly Schedule,
 * Downloadable books and Purchase link.
 */
function getMasterResourceLinks(language) {
  const ss = SpreadsheetApp.getActive();
  const master = ss.getSheetByName("MASTER");
  if (!master) return {};
  const data = master.getDataRange().getValues();
  if (!data || data.length < 2) return {};

  const headers = data[0].map(h => String(h || "").trim());
  const want = String(language || "").trim().toLowerCase();
  let langCol = headers.findIndex(h => String(h || "").trim().toLowerCase() === want);
  if (langCol < 0) {
    langCol = headers.findIndex(h => String(h || "").trim().toLowerCase() === "english");
  }
  if (langCol < 0) langCol = 2; // default fallback (column C)

  const rowFor = (recordType) => {
    const rt = String(recordType || "").trim().toLowerCase();
    return data.find(r => String(r[0] || "").trim().toLowerCase() === rt);
  };

  const overviewRow = rowFor("CocOverview");
  const scheduleRow = rowFor("CoCWeek1-20");
  const booksRow = rowFor("CoCBooks");
  const purchaseRow = rowFor("CoCPurchaseLink");

  return {
    overview: overviewRow ? String(overviewRow[langCol] || "").trim() : "",
    schedule: scheduleRow ? String(scheduleRow[langCol] || "").trim() : "",
    books: booksRow ? String(booksRow[langCol] || "").trim() : "",
    purchase: purchaseRow ? String(purchaseRow[langCol] || "").trim() : ""
  };
}

function getDownloadableBooksLabel(language) {
  return "Downloadable Books (link valid for 3 days only)";
}

/************************************************
 * DAILY BATCH PROCESSING WITH ALERTS
 * 
 * This function is designed to run daily (via time-based trigger).
 * It populates participants from CustomForm and sends alert emails
 * to language admins when new participants need group assignment.
 * 
 * SETUP INSTRUCTIONS:
 * 1. Ensure the spreadsheet has a sheet named "MASTER".
 * 2. In MASTER, add a row with RecordType = "AdminEmail"; language
 *    columns (e.g., English, Tamil, Hindi, Telugu, Kannada) must hold
 *    the admin email for each language.
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
  
  // Get language admin emails from MASTER sheet
  const adminEmailMap = getAdminEmailMapFromMaster();
  
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
    
    const adminEmail = adminEmailMap[lang] || getAdminEmailForLanguage(lang);
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
  const sendTerminatedEmail = (email, name, groupName, language, coordinatorEmail) => {
    const labels = getLifecycleEmailLabels(language);
    const subject = labels.terminatedSubject.replace('{groupName}', groupName);
    const body = labels.terminatedBody.replace('{name}', name).replace('{groupName}', groupName).replace('{regLink}', REG_LINK);
    const emailOptions = { to: email, subject, body };
    if (coordinatorEmail && coordinatorEmail.trim()) {
      emailOptions.cc = coordinatorEmail;
    }
    MailApp.sendEmail(emailOptions);
  };
  const sendDiscontinuedEmail = (email, name, groupName, language, coordinatorEmail) => {
    const labels = getLifecycleEmailLabels(language);
    const subject = labels.discontinuedSubject.replace('{groupName}', groupName);
    const body = labels.discontinuedBody.replace('{name}', name).replace('{groupName}', groupName).replace('{regLink}', REG_LINK);
    const emailOptions = { to: email, subject, body };
    if (coordinatorEmail && coordinatorEmail.trim()) {
      emailOptions.cc = coordinatorEmail;
    }
    MailApp.sendEmail(emailOptions);
  };

  // Helper to list participants for a group (case-insensitive)
  const listGroupParticipants = (groupName) => {
    const normalizedGroupName = groupName.trim().toLowerCase();
    return pData.filter(r => pIdx.AssignedGroup !== undefined && String(r[pIdx.AssignedGroup] || "").trim().toLowerCase() === normalizedGroupName);
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
      const coordinatorEmail = String(gRow[gIdx.CoordinatorEmail] || "").trim();
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
          sendTerminatedEmail(email, name, groupName, memberLang, coordinatorEmail);
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
  const adminEmailMap = getAdminEmailMapFromMaster();
  languages.forEach(lang => {
    const adminEmail = adminEmailMap[lang] || getAdminEmailForLanguage(lang);
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
 * 
 * OPTIMIZATIONS APPLIED:
 * 1. Bin Packing: Sorts slots by participant count for better distribution
 * 2. Coordinator-First: Prioritizes coordinator-willing participants
 * 3. Multi-Slot Flexibility: Tries all preferred slots, not just first
 * 4. Fixed Split Logic: Handles 1-4 remaining participants properly
 ************************************************/
function suggestGroupsForLanguage(language) {
  const MIN_GROUP_SIZE = 4;
  const MAX_GROUP_SIZE = 8;
  const TWO_GROUP_THRESHOLD = MAX_GROUP_SIZE + MIN_GROUP_SIZE; // e.g., 8 + 4 = 12
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
      !p.data[pIdx.Suggestions]
    );

  // Track summary counts
  const totalCandidates = participants.length;
  let suggestedExistingCount = 0; // suggested into existing active groups
  let suggestedNewCount = 0;      // suggested into newly proposed groups (NEW → ...)
  let unsuggestedCount = 0;       // leftover participants not suggested (e.g., <5 in a slot)

  // If nothing to suggest, show a quick notice
  if (totalCandidates === 0) {
    SpreadsheetApp.getUi().alert(
      `Suggest Groups – ${language}`,
      `No unassigned participants found for ${language}.`,
      SpreadsheetApp.getUi().ButtonSet.OK
    );
    return;
  }

  // Build existing groups map by language, slot, and eligibility
  const existingGroups = gData
    .filter(g => 
      g[gIdx.Language] === language &&
      g[gIdx.Status] === "Active" &&
      (g[gIdx.WeeksCompleted] || 0) <= 5 &&
      g[gIdx.MemberCount] < MAX_GROUP_SIZE
    )
    .map(g => ({
      name: g[gIdx.GroupName],
      day: normalizeDay(g[gIdx.Day]),
      time: normalizeTime(g[gIdx.Time]),
      memberCount: g[gIdx.MemberCount] || 0,
      capacity: MAX_GROUP_SIZE - (g[gIdx.MemberCount] || 0)
    }));

  // OPTIMIZATION #4: Multi-Slot Flexibility
  // Try to assign participants to existing groups using ANY of their preferred slots
  const assignedToExisting = new Set();
  
  participants.forEach(p => {
    if (assignedToExisting.has(p.row)) return;
    
    const slots = splitSlots(p.data[pIdx.PreferredSlots]);
    
    // Try each preferred slot
    for (const slot of slots) {
      const slotParts = slot.split(" ");
      const slotDay = normalizeDay(slotParts[0] || "TBD");
      const slotTime = normalizeTime(slotParts[1] || "TBD");
      
      // Find matching group with capacity
      const matchingGroup = existingGroups.find(g => 
        g.day === slotDay && g.time === slotTime && g.capacity > 0
      );
      
      if (matchingGroup) {
        const cell = pSheet.getRange(p.row, pIdx.Suggestions + 1);
        cell.setValue(matchingGroup.name);
        cell.setBackground("#FFF2CC");
        
        suggestedExistingCount++;
        matchingGroup.capacity--;
        matchingGroup.memberCount++;
        assignedToExisting.add(p.row);
        break; // Assigned, move to next participant
      }
    }
  });

  // Get remaining unassigned participants
  const unassignedParticipants = participants.filter(p => !assignedToExisting.has(p.row));

  // OPTIMIZATION #1: Bin Packing - Choose the densest preferred slot per participant
  // Build frequency map across ALL preferred slots, then assign each participant to
  // the slot (among their preferences) with the highest demand. This prevents missing
  // obvious groups when the first preferred slot is sparsely chosen.
  const slotCounts = {};
  unassignedParticipants.forEach(p => {
    const slots = splitSlots(p.data[pIdx.PreferredSlots]);
    slots.forEach(s => {
      slotCounts[s] = (slotCounts[s] || 0) + 1;
    });
  });

  const slotGroups = {};
  unassignedParticipants.forEach(p => {
    const slots = splitSlots(p.data[pIdx.PreferredSlots]);
    // Pick the slot with the highest overall count among this participant's options
    let bestSlot = slots[0] || "TBD";
    let bestCount = slotCounts[bestSlot] || 0;
    slots.forEach(s => {
      const c = slotCounts[s] || 0;
      if (c > bestCount) {
        bestSlot = s;
        bestCount = c;
      }
    });

    if (!slotGroups[bestSlot]) slotGroups[bestSlot] = [];
    slotGroups[bestSlot].push(p);
  });

  // Sort slots by participant count (descending) for better bin packing
  const sortedSlots = Object.keys(slotGroups).sort((a, b) => 
    slotGroups[b].length - slotGroups[a].length
  );

  let seq = getNextGroupSequenceByCount(gData, gIdx, language);

  // Process each time slot group (in descending order of size)
  sortedSlots.forEach(slot => {
    let remainingParticipants = slotGroups[slot];
    
    if (remainingParticipants.length === 0) return;

    // OPTIMIZATION #2: Coordinator-First Allocation
    // Separate coordinators from regular members
    const coordinators = remainingParticipants.filter(p => 
      p.data[pIdx.CoordinatorWilling] === true || 
      p.data[pIdx.CoordinatorWilling] === "TRUE" ||
      p.data[pIdx.CoordinatorWilling] === "true"
    );
    
    const members = remainingParticipants.filter(p => 
      p.data[pIdx.CoordinatorWilling] !== true && 
      p.data[pIdx.CoordinatorWilling] !== "TRUE" &&
      p.data[pIdx.CoordinatorWilling] !== "true"
    );

    // CRITICAL FIX #3: Improved group split logic with proper remainder handling
    const subgroups = [];
    
    // Strategy: Build groups around coordinators first
    coordinators.forEach(coord => {
      if (members.length === 0 && subgroups.length > 0) {
        // No more members, add coordinator to last group if space available
        if (subgroups[subgroups.length - 1].length < 8) {
          subgroups[subgroups.length - 1].push(coord);
        } else {
          // Create solo coordinator group (will be merged later if too small)
          subgroups.push([coord]);
        }
      } else {
        // Create group with coordinator + up to 7 members
        const groupSize = Math.min(7, members.length);
        const groupMembers = members.splice(0, groupSize);
        subgroups.push([coord, ...groupMembers]);
      }
    });

    // Handle remaining members (no coordinator available)
    let remaining = members.length;
    let index = 0;
    
    while (remaining > 0) {
      if (remaining <= MAX_GROUP_SIZE) {
        if (remaining >= 4) {
          // Create final group
          subgroups.push(members.slice(index));
        } else if (remaining >= 1) {
          // CRITICAL FIX: Handle 1-3 remaining participants
          if (subgroups.length > 0 && subgroups[subgroups.length - 1].length + remaining <= MAX_GROUP_SIZE) {
            // Merge with last group if it won't exceed 8
            subgroups[subgroups.length - 1] = subgroups[subgroups.length - 1].concat(members.slice(index));
          } else {
            // Can't merge, mark as unsuggested for manual review
            const uns = members.slice(index);
            uns.forEach(p => {
              const cell = pSheet.getRange(p.row, pIdx.Suggestions + 1);
              cell.setValue(`⚠️ NEEDS_MANUAL_REVIEW (${slot} - insufficient participants)`);
              cell.setBackground("#FFE6E6");
            });
            unsuggestedCount += uns.length;
          }
        }
        break;
      } else if (remaining <= TWO_GROUP_THRESHOLD) {
        // Split into two balanced groups (to avoid creating a group < MIN_GROUP_SIZE)
        const firstGroupSize = Math.ceil(remaining / 2);
        subgroups.push(members.slice(index, index + firstGroupSize));
        subgroups.push(members.slice(index + firstGroupSize));
        break;
      } else {
        // Take optimal group size (prefer 7 for better balance)
        const preferredSize = Math.max(MIN_GROUP_SIZE, MAX_GROUP_SIZE - 1);
        const groupSize = remaining >= (MAX_GROUP_SIZE + preferredSize) ? preferredSize : MAX_GROUP_SIZE;
        subgroups.push(members.slice(index, index + groupSize));
        index += groupSize;
        remaining -= groupSize;
      }
    }

    // Filter out groups that are too small (< MIN_GROUP_SIZE members)
    const validSubgroups = subgroups.filter(sg => sg.length >= MIN_GROUP_SIZE);
    const invalidSubgroups = subgroups.filter(sg => sg.length < MIN_GROUP_SIZE);
    
    // CRITICAL: Mark unsuggested participants for admin visibility
    invalidSubgroups.forEach(sg => {
      sg.forEach(p => {
        const cell = pSheet.getRange(p.row, pIdx.Suggestions + 1);
        cell.setValue(`⚠️ NEEDS_MANUAL_REVIEW (${slot} - insufficient participants)`);
        cell.setBackground("#FFE6E6"); // Light red to highlight manual review needed
        unsuggestedCount++;
      });
    });

    // Assign valid subgroups to new groups
    validSubgroups.forEach(subgroup => {
      const groupName = `NEW → CoC-${language}-${String(seq).padStart(3, "0")} (${slot})`;
      subgroup.forEach(p => {
        const cell = pSheet.getRange(p.row, pIdx.Suggestions + 1);
        cell.setValue(groupName);
        cell.setBackground("#FFF2CC"); // light yellow highlight for suggested cells
      });
      // Count suggestions to new groups
      suggestedNewCount += subgroup.length;
      seq++; // Increment for next group
    });
  });

  // Show summary confirmation
  const totalSuggested = suggestedExistingCount + suggestedNewCount;
  let summaryMessage = 
    `Participants considered: ${totalCandidates}` +
    `\nSuggested (existing groups): ${suggestedExistingCount}` +
    `\nSuggested (new groups): ${suggestedNewCount}` +
    `\nTotal suggested: ${totalSuggested}` +
    `\nCould not be suggested: ${unsuggestedCount}`;
  
  if (unsuggestedCount > 0) {
    summaryMessage += 
      `\n\n⚠️ ATTENTION: ${unsuggestedCount} participant(s) marked as "NEEDS_MANUAL_REVIEW"` +
      `\n\nThese participants are highlighted in LIGHT RED in the Suggestions column.` +
      `\n\nActions you can take:` +
      `\n• Manually assign them to existing groups with space` +
      `\n• Combine multiple small time slots` +
      `\n• Create custom groups of 4-5 if needed` +
      `\n• Contact participants about alternative time slots`;
  }
  
  SpreadsheetApp.getUi().alert(
    `Suggest Groups Summary – ${language}`,
    summaryMessage,
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
  const discontinuedCompletedParticipantIDs = [];
  const skippedParticipantIDs = [];
  let emailsSent = 0;
  let emailsFailed = 0;
  const errors = [];

  // ============ PASS 1: UPDATE PARTICIPANTS & GROUPS ============
  
  // Count candidates for processing
  const candidateCount = pData.filter(row => 
    row[pIdx.AcceptSuggestion] === true && (row[pIdx.Suggestions] || row[pIdx.AssignedGroup])
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
    
    // Check if participant is discontinued or completed
    const assignmentStatus = pIdx.AssignmentStatus !== undefined
      ? String(row[pIdx.AssignmentStatus] || "").trim().toLowerCase()
      : "";
    if (assignmentStatus === "discontinued" || assignmentStatus === "completed") {
      // Clear suggestion and checkbox, track for lifecycle email
      row[pIdx.Suggestions] = "";
      row[pIdx.AcceptSuggestion] = false;
      pData[i] = row;
      discontinuedCompletedParticipantIDs.push(row[pIdx.ParticipantID]);
      return;
    }
    
    // If no suggested group, use assigned group (for re-sending emails)
    // If both are empty, skip this row but clear the checkbox
    if (!row[pIdx.Suggestions] && !row[pIdx.AssignedGroup]) {
      row[pIdx.AcceptSuggestion] = false;
      pData[i] = row;
      skippedParticipantIDs.push(row[pIdx.ParticipantID] || `Row ${i + 2}`);
      return;
    }

    let groupName = "";
    let timing = "";
    let isReassignment = false;

    // If Suggestions is empty, use AssignedGroup (no group change, just email)
    if (!row[pIdx.Suggestions] && row[pIdx.AssignedGroup]) {
      groupName = row[pIdx.AssignedGroup];
      isReassignment = false; // Not changing assignment, just processing for email
    } else {
      // Process Suggestions as before
      isReassignment = true;
      
      const suggested = row[pIdx.Suggestions].trim();
      
      // Pattern a: "NEW → CoC-Tamil-020 (Mon Morning)"
      const newPatternMatch = suggested.match(/NEW\s*→\s*(CoC-[^-]+-\d{3})\s*\(([^)]+)\)/);
      if (newPatternMatch) {
        groupName = newPatternMatch[1].trim();
        timing = newPatternMatch[2].trim();
      } else {
        // Pattern b: "CoC-Tamil-020 (Mon Morning)" - with timing
        const cocWithTimingMatch = suggested.match(/(CoC-[^-]+-\d{3})\s*\(([^)]+)\)/);
        if (cocWithTimingMatch) {
          groupName = cocWithTimingMatch[1].trim();
          timing = cocWithTimingMatch[2].trim();
        } else {
          // Pattern c: "CoC-Tamil-020" - without timing
          const directMatch = suggested.match(/CoC-[^-]+-\d{3}/);
          if (directMatch) {
            groupName = directMatch[0].trim();
          } else {
            // Pattern d: Any custom name with optional timing in parentheses
            // e.g., "this-is-a-new-group (Tue evening)" or "CustomGroup"
            const customMatch = suggested.match(/^(.+?)(?:\s*\(([^)]+)\))?$/);
            if (customMatch) {
              groupName = customMatch[1].trim();
              timing = (customMatch[2] || "").trim();
            }
          }
        }
      }
    }

    if (!groupName) return;

    // Trim whitespace from group name
    groupName = groupName.trim();
    if (!groupName) return;

    // Create group if doesn't exist (case-insensitive check)
    const existingGroup = gData.find(g => String(g[gIdx.GroupName] || "").trim().toLowerCase() === groupName.toLowerCase());
    if (!existingGroup) {
      let day = "TBD";
      let time = "TBD";
      
      if (timing && timing !== "TBD") {
        const parts = timing.split(" ");
        day = parts[0] || "TBD";
        time = parts[1] || "TBD";
      }

      const newRow = new Array(gHeaders.length).fill("");
      newRow[gIdx.GroupID] = getNextGroupId(gData, gIdx);
      if (gIdx.GroupCreationDate !== undefined) newRow[gIdx.GroupCreationDate] = new Date();
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

      gSheet.getRange(gSheet.getLastRow() + 1, 1, 1, newRow.length).setValues([newRow]);
      SpreadsheetApp.flush();
      gData.push(newRow);
    }

    // Update participant
    if (isReassignment) {
      // Only update assignment if this is a new suggestion
      // Use existing group's case if found, otherwise use entered case
      row[pIdx.AssignedGroup] = existingGroup ? existingGroup[gIdx.GroupName] : groupName;
      row[pIdx.AssignmentStatus] = "Assigned";
      row[pIdx.Suggestions] = "";
      // Clear highlight on Suggestions cell after acceptance
      const suggestedCell = pSheet.getRange(i + 2, pIdx.Suggestions + 1);
      suggestedCell.setBackground(null);
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

      const groupName = String(participantRow[pIdxFresh.AssignedGroup] || "").trim();
      const groupRow = gDataFresh.find(g => String(g[gIdxFresh.GroupName] || "").trim().toLowerCase() === groupName.toLowerCase());
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
        const members = pDataFresh.filter(r => String(r[pIdxFresh.AssignedGroup] || "").trim().toLowerCase() === groupName.toLowerCase())
          .map(r => ({
            name: r[pIdxFresh.Name],
            email: r[pIdxFresh.Email],
            whatsapp: r[pIdxFresh.WhatsApp],
            center: r[pIdxFresh.Center]
          }));
        sendCoordinatorAssignmentEmail(participantRow[pIdxFresh.Email], participantRow[pIdxFresh.Name], participantRow[pIdxFresh.Language], groupInfo, members);
      } else {
        // Send member email with coordinator info
        sendMemberAssignmentEmail(
          participantRow[pIdxFresh.Email],
          participantRow[pIdxFresh.Name],
          participantRow[pIdxFresh.Language],
          groupInfo,
          {
            whatsapp: participantRow[pIdxFresh.WhatsApp],
            center: participantRow[pIdxFresh.Center]
          }
        );
      }
      
      emailsSent++;
    } catch (error) {
      emailsFailed++;
      errors.push(`❌ ${participantID}: ${error.message}`);
    }
    });

    // ============ PASS 2B: SEND LIFECYCLE EMAILS FOR DISCONTINUED/COMPLETED ============
    discontinuedCompletedParticipantIDs.forEach(participantID => {
      try {
        const participantRow = pDataFresh.find(r => r[pIdxFresh.ParticipantID] === participantID);
        if (!participantRow) {
          emailsFailed++;
          errors.push(`❌ ${participantID}: Not found in fresh data for lifecycle email`);
          return;
        }

        const name = participantRow[pIdxFresh.Name];
        const email = participantRow[pIdxFresh.Email];
        const language = participantRow[pIdxFresh.Language];
        const groupName = participantRow[pIdxFresh.AssignedGroup] || "";
        const status = pIdxFresh.AssignmentStatus !== undefined
          ? String(participantRow[pIdxFresh.AssignmentStatus] || "").trim()
          : "";

        const labels = getLifecycleEmailLabels(language);
        const REG_LINK = "https://www.hcessentials.org/coc-registration-form";

        if (status === "Discontinued") {
          // Get coordinator email from Groups sheet
          const groupRow = gDataFresh.find(g => String(g[gIdxFresh.GroupName] || "").trim().toLowerCase() === groupName.toLowerCase());
          const coordinatorEmail = groupRow && gIdxFresh.CoordinatorEmail !== undefined ? String(groupRow[gIdxFresh.CoordinatorEmail] || "").trim() : "";
          
          sendDiscontinuedEmail(email, name, groupName, language, coordinatorEmail);
        } else if (status === "Completed") {
          const wasActive = participantRow[pIdxFresh.IsActive] === true || participantRow[pIdxFresh.IsActive] === "TRUE";
          const subject = labels.closedSubject.replace('{groupName}', groupName);
          const body = wasActive
            ? labels.closedBodyActive.replace('{name}', name).replace('{groupName}', groupName).replace('{regLink}', REG_LINK)
            : labels.closedBodyInactive.replace('{name}', name).replace('{groupName}', groupName).replace('{regLink}', REG_LINK);
          MailApp.sendEmail({ to: email, subject, body });
        }

        emailsSent++;
      } catch (error) {
        emailsFailed++;
        errors.push(`❌ ${participantID}: ${error.message}`);
      }
    });
  }
  
  // Show summary
  let message = `✅ Processed: ${processedParticipantIDs.length + discontinuedCompletedParticipantIDs.length}\n`;
  if (discontinuedCompletedParticipantIDs.length > 0) {
    message += `📧 Discontinued/Completed: ${discontinuedCompletedParticipantIDs.length}\n`;
  }
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

  // Build member map (ignore discontinued so counts reflect active members)
  // Use lowercase keys for case-insensitive matching
  const members = {};
  const groupNameMap = {}; // Maps lowercase to original case
  pData.forEach(r => {
    if (!r[pIdx.AssignedGroup]) return;

    const assignmentStatus = pIdx.AssignmentStatus !== undefined
      ? String(r[pIdx.AssignmentStatus] || "").trim().toLowerCase()
      : "";
    if (assignmentStatus === "discontinued") return;

    const groupName = String(r[pIdx.AssignedGroup] || "").trim();
    if (!groupName) return;
    const groupNameKey = groupName.toLowerCase();
    
    if (!members[groupNameKey]) {
      members[groupNameKey] = [];
      groupNameMap[groupNameKey] = groupName; // Store first occurrence's case
    }

    members[groupNameKey].push(r);
  });

  // Find existing group names (case-insensitive)
  const existingGroups = new Set(gData.map(r => String(r[gIdx.GroupName] || "").toLowerCase()).filter(Boolean));

  // Create missing groups
  const newGroups = [];
  Object.keys(members).forEach(groupNameKey => {
    if (!existingGroups.has(groupNameKey)) {
      const groupName = groupNameMap[groupNameKey]; // Use original case
      const firstMember = members[groupNameKey][0];
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
      const coordinator = members[groupNameKey].find(m => {
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

      existingGroups.add(groupNameKey);
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
    const groupNameKey = String(r[gIdx.GroupName] || "").trim().toLowerCase();
    const m = members[groupNameKey] || [];
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
    { key: "CompletedClosedGroups", label: "Completed/Closed Groups" },
    { key: "TerminatedGroups", label: "Terminated Groups" }
  ];
  
  const participantsMetrics = [
    { key: "Unassigned", label: "Unassigned Participants", highlight: true },
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
      } else if (m.key === "CompletedClosedGroups") {
        v = g.filter(r => r[gIdx.Language] === l && (r[gIdx.Status] === "Completed" || r[gIdx.Status] === "Closed")).length;
      } else if (m.key === "TerminatedGroups") {
        v = g.filter(r => r[gIdx.Language] === l && r[gIdx.Status] === "Terminated").length;
      } else if (m.key === "NoCoordinator") {
        v = g.filter(r => r[gIdx.Language] === l && !r[gIdx.CoordinatorEmail] && r[gIdx.Status] !== "Terminated" && r[gIdx.Status] !== "Closed").length;
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
function normalizeDay(d) {
  const dayMap = {
    'mon': 'Mon', 'monday': 'Mon',
    'tue': 'Tue', 'tues': 'Tue', 'tuesday': 'Tue',
    'wed': 'Wed', 'wednesday': 'Wed',
    'thu': 'Thu', 'thur': 'Thu', 'thurs': 'Thu', 'thursday': 'Thu',
    'fri': 'Fri', 'friday': 'Fri',
    'sat': 'Sat', 'saturday': 'Sat',
    'sun': 'Sun', 'sunday': 'Sun'
  };
  const normalized = String(d || "").toLowerCase().trim();
  return dayMap[normalized] || String(d || "TBD").trim();
}
function normalizeTime(t) {
  const timeMap = {
    'morning': 'Morning', 'morn': 'Morning', 'am': 'Morning',
    'afternoon': 'Afternoon', 'aft': 'Afternoon', 'noon': 'Afternoon',
    'evening': 'Evening', 'eve': 'Evening', 'pm': 'Evening',
    'night': 'Night'
  };
  const normalized = String(t || "").toLowerCase().trim();
  return timeMap[normalized] || String(t || "TBD").trim();
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
function sendMemberAssignmentEmail(email, name, language, groupInfo, memberInfo = {}) {
  if (!email || !email.trim()) {
    throw new Error(`Invalid email address for ${name}`);
  }
  
  const labels = getEmailLabels(language);
  const memberWhatsapp = memberInfo.whatsapp || labels.notProvided;
  const memberCenter = memberInfo.center || labels.notProvided;
  
  const subject = labels.memberSubject;
  const links = getMasterResourceLinks(language);
  const booksLabel = getDownloadableBooksLabel(language);
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
    <p>${labels.memberClosing}</p>
    <br>
    <p><strong>${labels.memberDetailsTitle}</strong></p>
    <p><strong>${labels.name}:</strong> ${name}</p>
    <p><strong>${labels.email}:</strong> ${email}</p>
    <p><strong>${labels.whatsapp}:</strong> ${memberWhatsapp}</p>
    <p><strong>${labels.center}:</strong> ${memberCenter}</p>
    <br>
    <p>${labels.memberUseWhatsappNote}</p>
    <br>
    <p><strong>${labels.resourcesTitle}</strong></p>
    ${links.overview ? `<p><strong>${labels.cocOverview}</strong> - <a href="${links.overview}">${links.overview}</a></p>` : ""}
    ${links.schedule ? `<p><strong>${labels.cocSchedule}</strong> - <a href="${links.schedule}">${links.schedule}</a></p>` : ""}
    ${links.books ? `<p><strong>${booksLabel}</strong> - <a href="${links.books}">${links.books}</a></p>` : ""}
    <p><strong>${labels.nvcBook}</strong><br>
    ${labels.bookPurchase} ${links.purchase ? `<a href="${links.purchase}">${links.purchase}</a>` : ""}</p>
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
      <td>${m.center || labels.notProvided}</td>
    </tr>
  `).join('');
  
  const subject = labels.coordinatorSubject;
  const links = getMasterResourceLinks(language);
  const booksLabel = getDownloadableBooksLabel(language);
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
        <th>${labels.center}</th>
      </tr>
      ${memberListHtml}
    </table>
    <br>
    <p><strong>${labels.nextSteps}</strong></p>
    <ol>
      <li>${labels.createWhatsApp}</li>
      <li>${labels.updateWhatsApp}
        <ul style="margin-top: 10px;">
          ${links.overview ? `<li><strong>${labels.cocOverview}</strong> - <a href="${links.overview}">${links.overview}</a></li>` : ""}
          ${links.schedule ? `<li><strong>${labels.cocSchedule}</strong> - <a href="${links.schedule}">${links.schedule}</a></li>` : ""}
          ${links.books ? `<li><strong>${booksLabel}</strong> - <a href="${links.books}">${links.books}</a></li>` : ""}
          <li><strong>${labels.nvcBook}</strong><br>
          ${labels.bookPurchase} ${links.purchase ? `<a href="${links.purchase}">${links.purchase}</a>` : ""}</li>
        </ul>
      </li>
      <li>${labels.publishMeetingLink}</li>
      <li>${labels.coordinatorUpdate} <a href="https://www.hcessentials.org/coc-coordinator-update">https://www.hcessentials.org/coc-coordinator-update</a>
        <br><em>${labels.coordinatorUpdateNote}</em>
      </li>
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
      center: "Center",
      memberDetailsTitle: "Your details (for coordinator reference)",
      notProvided: "Not provided",
      useDetailsNote: "Use the WhatsApp numbers above to add members to the group promptly.",
      memberUseWhatsappNote: "Use the WhatsApp number above to add the member to your group promptly.",
      memberClosing: "Your coordinator will reach out to you soon with further details.",
      coordinatorClosing: "Please reach out to your group members to schedule the first session.",
      regards: "Best regards,<br>CoC Team",
      resourcesTitle: "Please refer to the following documents for information:",
      cocOverview: "CoC Overview",
      cocSchedule: "CoC Weekly Schedule and Study Materials",
      nvcBook: "Nonviolent Communication: A Language of Life (3rd Edition):",
      bookPurchase: "Book can be purchased at:",
      whatsappNote: "Your Coordinator will add you to your CoC WhatsApp group within a day or two. If you have not been added, you may directly reach out to your coordinator whose contact details are above.",
      nextSteps: "Next Steps:",
      createWhatsApp: "Create a WhatsApp group for your CoC Study Group with the above members if you haven't already.",
      updateWhatsApp: "Update the following details in the WhatsApp Group's description:",
      publishMeetingLink: "Publish the Zoom or Google Meet link for your initial and weekly meetings in the WhatsApp group.",
      coordinatorUpdate: "Submit the Coordinator's update for after each weekly session:",
      coordinatorUpdateNote: "Mark only the members who regularly attend your sessions. Missing 1-2 sessions here and there is okay."
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
      center: "மையம்",
      memberDetailsTitle: "உங்கள் விவரங்கள் (ஒருங்கிணைப்பாளர் குறிப்புக்கு)",
      notProvided: "வழங்கப்படவில்லை",
      useDetailsNote: "மேலே உள்ள வாட்ஸ்அப் விவரங்களைப் பயன்படுத்தி உறுப்பினர்களை உடனே குழுவில் சேர்க்கவும்.",
      memberUseWhatsappNote: "மேலே உள்ள வாட்ஸ்அப் எண்ணைப் பயன்படுத்தி உறுப்பினரை உடனே உங்கள் குழுவில் சேர்க்கவும்.",
      memberClosing: "உங்கள் ஒருங்கிணைப்பாளர் விரைவில் மேலும் விவரங்களுடன் உங்களை தொடர்பு கொள்வார்.",
      coordinatorClosing: "முதல் அமர்வை திட்டமிட உங்கள் குழு உறுப்பினர்களை தொடர்பு கொள்ளவும்.",
      regards: "நன்றி,<br>CoC குழு",
      resourcesTitle: "தகவலுக்கு பின்வரும் ஆவணங்களைப் பார்க்கவும்:",
      cocOverview: "CoC கண்ணோட்டம்",
      cocSchedule: "CoC வாராந்திர அட்டவணை மற்றும் படிப்புப் பொருட்கள்",
      nvcBook: "அகிம்சை தொடர்பு: வாழ்க்கையின் மொழி (3வது பதிப்பு) ஆங்கிலம் :",
      bookPurchase: "புத்தகத்தை வாங்க:",
      whatsappNote: "உங்கள் ஒருங்கிணைப்பாளர் ஒரு அல்லது இரண்டு நாட்களுக்குள் உங்களை CoC வாட்ஸ்அப் குழுவில் சேர்ப்பார். நீங்கள் சேர்க்கப்படவில்லை என்றால், மேலே உள்ள தொடர்பு விவரங்களைப் பயன்படுத்தி நேரடியாக உங்கள் ஒருங்கிணைப்பாளரைத் தொடர்பு கொள்ளலாம்.",
      nextSteps: "அடுத்த படிகள்:",
      createWhatsApp: "ஏற்கனவே இல்லாவிட்டால், மேலே உள்ள உறுப்பினர்களுடன் உங்கள் CoC படிப்பு குழுவிற்கான வாட்ஸ்அப் குழுவை உருவாக்கவும்.",
      updateWhatsApp: "வாட்ஸ்அப் குழுவின் Description-ல் பின்வரும் விவரங்களைப் புதுப்பிக்கவும்:",
      publishMeetingLink: "வாட்ஸ்அப் குழுவில் உங்கள் ஆரம்ப மற்றும் வாராந்திர கூட்டங்களுக்கான Zoom அல்லது Google Meet இணைப்பை வெளியிடவும்.",
      coordinatorUpdate: "ஒவ்வொரு வாராந்திர அமர்வுக்குப் பிறகு ஒருங்கிணைப்பாளரின் மேம்பாட்டை சமர்ப்பிக்கவும்:",
      coordinatorUpdateNote: "தொடர்ந்து கலந்துகொள்ளும் உறுப்பினர்களை மட்டுமே குறிக்கவும். 1-2 அமர்வுகளை தவறவிடுவது சரிதான்."
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
      center: "केंद्र",
      memberDetailsTitle: "आपकी जानकारी (समन्वयक संदर्भ हेतु)",
      notProvided: "उपलब्ध नहीं",
      useDetailsNote: "ऊपर दिए गए व्हाट्सएप विवरण का उपयोग करके सदस्यों को तुरंत समूह में जोड़ें।",
      memberUseWhatsappNote: "ऊपर दिए गए व्हाट्सएप नंबर का उपयोग करके सदस्य को तुरंत अपने समूह में जोड़ें।",
      memberClosing: "आपके समन्वयक जल्द ही अधिक विवरण के साथ आपसे संपर्क करेंगे।",
      coordinatorClosing: "कृपया पहला सत्र निर्धारित करने के लिए अपने समूह सदस्यों से संपर्क करें।",
      regards: "सादर,<br>CoC टीम",
      resourcesTitle: "जानकारी के लिए कृपया निम्नलिखित दस्तावेज़ देखें:",
      cocOverview: "CoC अवलोकन",
      cocSchedule: "CoC साप्ताहिक कार्यक्रम और अध्ययन सामग्री",
      nvcBook: "अहिंसक संचार: जीवन की भाषा (तीसरा संस्करण):",
      bookPurchase: "पुस्तक यहाँ से खरीदी जा सकती है:",
      whatsappNote: "आपके समन्वयक एक या दो दिन में आपको CoC व्हाट्सएप समूह में जोड़ेंगे। यदि आपको नहीं जोड़ा गया है, तो आप ऊपर दिए गए संपर्क विवरण का उपयोग करके सीधे अपने समन्वयक से संपर्क कर सकते हैं।",
      nextSteps: "अगले कदम:",
      createWhatsApp: "यदि आपने अभी तक उपरोक्त सदस्यों के साथ अपने CoC अध्ययन समूह के लिए व्हाट्सएप समूह नहीं बनाया है तो बनाएं।",
      updateWhatsApp: "व्हाट्सएप समूह के विवरण में निम्नलिखित जानकारी अपडेट करें:",
      publishMeetingLink: "व्हाट्सएप समूह में अपनी प्रारंभिक और साप्ताहिक बैठकों के लिए Zoom या Google Meet लिंक प्रकाशित करें।",
      coordinatorUpdate: "प्रत्येक साप्ताहिक सत्र के बाद समन्वयक की अपडेट जमा करें:",
      coordinatorUpdateNote: "केवल उन सदस्यों को चिह्नित करें जो नियमित रूप से आपके सत्रों में भाग लेते हैं। 1-2 सत्र यहाँ और वहाँ मिस करना ठीक है।"
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
      center: "ಕೇಂದ್ರ",
      memberDetailsTitle: "ನಿಮ್ಮ ವಿವರಗಳು (ಸಮನ್ವಯಕರ ಉಲ್ಲೇಖಕ್ಕಾಗಿ)",
      notProvided: "ಲಭ್ಯವಿಲ್ಲ",
      useDetailsNote: "ಮೇಲಿನ ವಾಟ್ಸಾಪ್ ವಿವರಗಳನ್ನು ಬಳಸಿ ಸದಸ್ಯರನ್ನು ಶೀಘ್ರವಾಗಿ ಗುಂಪಿಗೆ ಸೇರಿಸಿ.",
      memberUseWhatsappNote: "ಮೇಲಿನ ವಾಟ್ಸಾಪ್ ಸಂಖ್ಯೆಯನ್ನು ಬಳಸಿ ಸದಸ್ಯರನ್ನು ತ್ವರಿತವಾಗಿ ನಿಮ್ಮ ಗುಂಪಿಗೆ ಸೇರಿಸಿ.",
      memberClosing: "ನಿಮ್ಮ ಸಮನ್ವಯಕ ಶೀಘ್ರದಲ್ಲೇ ಹೆಚ್ಚಿನ ವಿವರಗಳೊಂದಿಗೆ ನಿಮ್ಮನ್ನು ಸಂಪರ್ಕಿಸುತ್ತಾರೆ.",
      coordinatorClosing: "ಮೊದಲ ಅಧಿವೇಶನವನ್ನು ನಿಗದಿಪಡಿಸಲು ದಯವಿಟ್ಟು ನಿಮ್ಮ ಗುಂಪು ಸದಸ್ಯರನ್ನು ಸಂಪರ್ಕಿಸಿ.",
      regards: "ಧನ್ಯವಾದಗಳು,<br>CoC ತಂಡ",
      resourcesTitle: "ಮಾಹಿತಿಗಾಗಿ ದಯವಿಟ್ಟು ಈ ಕೆಳಗಿನ ದಾಖಲೆಗಳನ್ನು ನೋಡಿ:",
      cocOverview: "CoC ಅವಲೋಕನ",
      cocSchedule: "CoC ವಾರಾಂತ್ಯ ವೇಳಾಪಟ್ಟಿ ಮತ್ತು ಅಧ್ಯಯನ ಸಾಮಗ್ರಿಗಳು",
      nvcBook: "ಅಹಿಂಸಾ ಸಂವಹನ: ಜೀವನದ ಭಾಷೆ (3ನೇ ಆವೃತ್ತಿ):",
      bookPurchase: "ಪುಸ್ತಕವನ್ನು ಇಲ್ಲಿ ಖರೀದಿಸಬಹುದು:",
      whatsappNote: "ನಿಮ್ಮ ಸಮನ್ವಯಕರು ಒಂದು ಅಥವಾ ಎರಡು ದಿನಗಳಲ್ಲಿ ನಿಮ್ಮನ್ನು CoC ವಾಟ್ಸಾಪ್ ಗುಂಪಿಗೆ ಸೇರಿಸುತ್ತಾರೆ. ನೀವು ಸೇರಿಸದಿದ್ದರೆ, ಮೇಲೆ ನೀಡಲಾದ ಸಂಪರ್ಕ ವಿವರಗಳನ್ನು ಬಳಸಿಕೊಂಡು ನೀವು ನೇರವಾಗಿ ನಿಮ್ಮ ಸಮನ್ವಯಕರನ್ನು ಸಂಪರ್ಕಿಸಬಹುದು.",
      nextSteps: "ಮುಂದಿನ ಹಂತಗಳು:",
      createWhatsApp: "ನೀವು ಇಂದುವರೆಗೆ ಮೇಲಿನ ಸದಸ್ಯರೊಂದಿಗೆ ನಿಮ್ಮ CoC ಅಧ್ಯಯನ ಗುಂಪಿಗೆ ವಾಟ್ಸಾಪ್ ಗುಂಪನ್ನು ರಚಿಸದಿದ್ದರೆ ರಚಿಸಿ।",
      updateWhatsApp: "ವಾಟ್ಸಾಪ್ ಗುಂಪಿನ ವಿವರಣೆಯಲ್ಲಿ ಈ ಕೆಳಗಿನ ವಿವರಗಳನ್ನು ಅಪ್‌ಡೇಟ್ ಮಾಡಿ:",
      publishMeetingLink: "ವಾಟ್ಸಾಪ್ ಗುಂಪಿನಲ್ಲಿ ನಿಮ್ಮ ಆರಂಭಿಕ ಮತ್ತು ವಾರಾಂತ್ಯ ಸಭೆಗಳಿಗೆ Zoom ಅಥವಾ Google Meet ಲಿಂಕ್ ಪ್ರಕಾಶಿಸಿ।",
      coordinatorUpdate: "ಪ್ರತಿ ವಾರದ ಅಧಿವೇಶನದ ನಂತರ ಸಮನ್ವಯಕರ ಅಪ್‌ಡೇಟ್ ಸಲ್ಲಿಸಿ:",
      coordinatorUpdateNote: "ನಿয়ಮಿತವಾಗಿ ನಿಮ್ಮ ಸೆಷನ್‌ಗಳಿಗೆ ಹಾಜರಿರುವ ಸದಸ್ಯರನ್ನು ಮಾತ್ರ ಗುರುತಿಸಿ। ಇಲ್ಲಿ ಮತ್ತು ಅಲ್ಲಿ 1-2 ಸೆಷನ್‌ಗಳನ್ನು ಮಿಸ್ ಮಾಡುವುದು ಠಿಕ್ಕಾಗಿದೆ."
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
      center: "కేంద్రం",
      memberDetailsTitle: "మీ వివరాలు (సమన్వయకర్త సూచన కోసం)",
      notProvided: "లభ్యం కాదు",
      useDetailsNote: "పైనున్న వాట్సాప్ వివరాలను ఉపయోగించి సభ్యులను వెంటనే గ్రూప్‌లో చేర్చండి.",
      memberUseWhatsappNote: "పైనున్న వాట్సాప్ నంబర్‌ను ఉపయోగించి సభ్యుడిని వెంటనే మీ గ్రూప్‌లో చేర్చండి.",
      memberClosing: "మీ సమన్వయకర్త త్వరలో మరిన్ని వివరాలతో మిమ్మల్ని సంప్రదిస్తారు.",
      coordinatorClosing: "దయచేసి మొదటి సెషన్‌ను షెడ్యూల్ చేయడానికి మీ సమూహ సభ్యులను సంప్రదించండి.",
      regards: "శుభాకాంక్షలు,<br>CoC బృందం",
      resourcesTitle: "సమాచారం కోసం దయచేసి క్రింది పత్రాలను చూడండి:",
      cocOverview: "CoC అవలోకనం",
      cocSchedule: "CoC వారపు షెడ్యూల్ మరియు అధ్యయన పత్రాలు",
      nvcBook: "అహింసా సంభాషణ: జీవితం యొక్క భాష (3వ ఎడిషన్):",
      bookPurchase: "పుస్తకాన్ని ఇక్కడ కొనుగోలు చేయవచ్చు:",
      whatsappNote: "మీ సమన్వయకర్త ఒకటి లేదా రెండు రోజుల్లో మిమ్మల్ని CoC వాట్సాప్ సమూహంలో చేర్చుతారు. మీరు చేర్చబడకపోతే, పైన ఇచ్చిన సంప్రదింపు వివరాలను ఉపయోగించి మీరు నేరుగా మీ సమన్వయకర్తను సంప్రదించవచ్చు.",
      nextSteps: "తదుపరి దశలు:",
      createWhatsApp: "మీరు ఇంకా పై సభ్యులతో మీ CoC అధ్యయన సమూహానికి వాట్సాప్ సమూహాన్ని సృష్టించనట్లయితే సృష్టించండి।",
      updateWhatsApp: "వాట్సాప్ సమూహ వివరణలో క్రింది వివరాలను అపడేట్ చేయండి:",
      publishMeetingLink: "వాట్సాప్ సమూహంలో మీ ప్రారంభ మరియు వారపు సమావేశాల కోసం Zoom లేదా Google Meet లింక్‌ను ప్రచురించండి.",
      coordinatorUpdate: "ప్రతి వారపు సెషన్ తర్వాత సమన్వయకర్త యొక్క అపడేట్ సమర్పించండి:",
      coordinatorUpdateNote: "మీ సెషన్‌లకు సాధారణంగా హాజరుకాని సభ్యులను మాత్రమే గుర్తించండి. ఇక్కడ మరియు అక్కడ 1-2 సెషన్‌లను కోల్పోవడం సరిగ్గా ఉంది."
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
      terminatedBody: "Dear {name},\n\nYour CoC group ({groupName}) has been dissolved as it has not been functioning. We acknowledge your efforts.\n\nIf you think this is an error and/or you would like to continue your CoC journey, please reply to this email, or get in touch with your coordinator. Alternatively, you can register again at {regLink} for a new group.\n\nWith best wishes,\nCoC Admin Team",
      discontinuedSubject: "CoC Participation Discontinued - {groupName}",
      discontinuedBody: "Dear {name},\n\nWe have unregistered your membership from the CoC group ({groupName}) as you have not been joining sessions. We understand you may have other commitments or personal situations.\n\nIf you think your deregistration is an error and/or you would like to continue your CoC journey, please reply to this email, or get in touch with your coordinator. Alternatively, you can register again at {regLink}.\n\nWith best wishes,\nCoC Admin Team"
    },
    Tamil: {
      closedSubject: "CoC குழு மூடப்பட்டது - {groupName}",
      closedBodyActive: "அன்புள்ள {name},\n\nநீங்கள் அனைத்து அமர்வுகளையும் முடித்துவிட்டதால் உங்கள் CoC குழு ({groupName}) இப்போது மூடப்பட்டுள்ளது. உங்கள் CoC பயணத்தை வெற்றிகரமாக முடித்ததற்கு வாழ்த்துக்கள்! நீங்கள் புதிய குழுவுடன் மீண்டும் செய்ய விரும்பினால், {regLink} இல் மீண்டும் பதிவு செய்யவும்.\n\nநல்வாழ்த்துகளுடன்,\nCoC நிர்வாகக் குழு",
      closedBodyInactive: "அன்புள்ள {name},\n\nகுழு அனைத்து அமர்வுகளையும் முடித்துவிட்டதால் உங்கள் CoC குழு ({groupName}) இப்போது மூடப்பட்டுள்ளது. உங்களுக்கு வேறு கடமைகள் அல்லது தனிப்பட்ட சூழ்நிலைகள் இருந்திருக்கலாம் என்பதை நாங்கள் புரிந்துகொள்கிறோம். எதிர்காலத்தில் உங்கள் CoC பயணத்தைத் தொடர விரும்பினால், {regLink} இல் பதிவு செய்யவும்.\n\nநல்வாழ்த்துகளுடன்,\nCoC நிர்வாகக் குழு",
      terminatedSubject: "CoC குழு கலைக்கப்பட்டது - {groupName}",
      terminatedBody: "அன்புள்ள {name},\n\nஉங்கள் CoC குழு ({groupName}) செயல்படவில்லை என்பதால் கலைக்கப்பட்டுள்ளது. உங்கள் முயற்சிகளை நாங்கள் அங்கீகரிக்கிறோம்.\n\nஇது பிழை என்று நீங்கள் நினைத்தால் மற்றும்/அல்லது உங்கள் CoC பயணத்தைத் தொடர விரும்பினால், தயவுசெய்து இந்த மின்னஞ்சலுக்கு பதிலளிக்கவும், அல்லது உங்கள் ஒருங்கிணைப்பாளரைத் தொடர்பு கொள்ளவும். அல்லது, புதிய குழுவிற்கு {regLink} இல் மீண்டும் பதிவு செய்யலாம்.\n\nநல்வாழ்த்துகளுடன்,\nCoC நிர்வாகக் குழு",
      discontinuedSubject: "CoC பங்கேற்பு நிறுத்தப்பட்டது - {groupName}",
      discontinuedBody: "அன்புள்ள {name},\n\nநீங்கள் அமர்வுகளில் கலந்து கொள்ளாததால் CoC குழுவில் ({groupName}) உங்கள் உறுப்பினராக்கத்தை ரத்து செய்துள்ளோம். உங்களுக்கு வேறு கடமைகள் அல்லது தனிப்பட்ட சூழ்நிலைகள் இருக்கலாம் என்பதை நாங்கள் புரிந்துகொள்கிறோம்.\n\nஉங்கள் பதிவு நீக்கம் பிழை என்று நீங்கள் நினைத்தால் மற்றும்/அல்லது உங்கள் CoC பயணத்தைத் தொடர விரும்பினால், தயவுசெய்து இந்த மின்னஞ்சலுக்கு பதிலளிக்கவும், அல்லது உங்கள் ஒருங்கிணைப்பாளரைத் தொடர்பு கொள்ளவும். அல்லது, நீங்கள் {regLink} இல் மீண்டும் பதிவு செய்யலாம்.\n\nநல்வாழ்த்துகளுடன்,\nCoC நிர்வாகக் குழு"
    },
    Hindi: {
      closedSubject: "CoC समूह बंद - {groupName}",
      closedBodyActive: "प्रिय {name},\n\nआपका CoC समूह ({groupName}) अब बंद हो गया है क्योंकि आपने सभी सत्र पूरे कर लिए हैं। अपनी CoC यात्रा को सफलतापूर्वक पूरा करने के लिए बधाई! यदि आप एक नए समूह के साथ दोहराना चाहते हैं, तो कृपया {regLink} पर फिर से पंजीकरण करें।\n\nशुभकामनाओं के साथ,\nCoC प्रशासन टीम",
      closedBodyInactive: "प्रिय {name},\n\nआपका CoC समूह ({groupName}) अब बंद हो गया है क्योंकि समूह ने सभी सत्र पूरे कर लिए हैं। हम समझते हैं कि आपकी अन्य प्रतिबद्धताएँ या व्यक्तिगत परिस्थितियाँ हो सकती हैं। यदि आप भविष्य में अपनी CoC यात्रा जारी रखना चाहते हैं, तो कृपया {regLink} पर पंजीकरण करें।\n\nशुभकामनाओं के साथ,\nCoC प्रशासन टीम",
      terminatedSubject: "CoC समूह समाप्त - {groupName}",
      terminatedBody: "प्रिय {name},\n\nआपका CoC समूह ({groupName}) भंग कर दिया गया है क्योंकि यह कार्य नहीं कर रहा था। हम आपके प्रयासों को स्वीकार करते हैं।\n\nयदि आपको लगता है कि यह एक त्रुटि है और/या आप अपनी CoC यात्रा जारी रखना चाहते हैं, तो कृपया इस ईमेल का उत्तर दें, या अपने समन्वयक से संपर्क करें। वैकल्पिक रूप से, आप एक नए समूह के लिए {regLink} पर फिर से पंजीकरण कर सकते हैं।\n\nशुभकामनाओं के साथ,\nCoC प्रशासन टीम",
      discontinuedSubject: "CoC भागीदारी बंद - {groupName}",
      discontinuedBody: "प्रिय {name},\n\nआप सत्रों में शामिल नहीं हो रहे थे इसलिए हमने CoC समूह ({groupName}) से आपकी सदस्यता समाप्त कर दी है। हम समझते हैं कि आपकी अन्य प्रतिबद्धताएँ या व्यक्तिगत परिस्थितियाँ हो सकती हैं।\n\nयदि आपको लगता है कि आपका पंजीकरण रद्द करना एक त्रुटि है और/या आप अपनी CoC यात्रा जारी रखना चाहते हैं, तो कृपया इस ईमेल का उत्तर दें, या अपने समन्वयक से संपर्क करें। वैकल्पिक रूप से, आप {regLink} पर फिर से पंजीकरण कर सकते हैं।\n\nशुभकामनाओं के साथ,\nCoC प्रशासन टीम"
    },
    Kannada: {
      closedSubject: "CoC ಗುಂಪು ಮುಚ್ಚಲಾಗಿದೆ - {groupName}",
      closedBodyActive: "ಆತ್ಮೀಯ {name},\n\nನೀವು ಎಲ್ಲಾ ಅಧಿವೇಶನಗಳನ್ನು ಪೂರ್ಣಗೊಳಿಸಿದ್ದರಿಂದ ನಿಮ್ಮ CoC ಗುಂಪು ({groupName}) ಈಗ ಮುಚ್ಚಲಾಗಿದೆ. ನಿಮ್ಮ CoC ಪ್ರಯಾಣವನ್ನು ಯಶಸ್ವಿಯಾಗಿ ಪೂರ್ಣಗೊಳಿಸಿದ್ದಕ್ಕಾಗಿ ಅಭಿನಂದನೆಗಳು! ನೀವು ಹೊಸ ಗುಂಪಿನೊಂದಿಗೆ ಪುನರಾವರ್ತಿಸಲು ಬಯಸಿದರೆ, ದಯವಿಟ್ಟು {regLink} ನಲ್ಲಿ ಮತ್ತೆ ನೋಂದಾಯಿಸಿ.\n\nಶುಭಾಶಯಗಳೊಂದಿಗೆ,\nCoC ನಿರ್ವಹಣಾ ತಂಡ",
      closedBodyInactive: "ಆತ್ಮೀಯ {name},\n\nಗುಂಪು ಎಲ್ಲಾ ಅಧಿವೇಶನಗಳನ್ನು ಪೂರ್ಣಗೊಳಿಸಿದ್ದರಿಂದ ನಿಮ್ಮ CoC ಗುಂಪು ({groupName}) ಈಗ ಮುಚ್ಚಲಾಗಿದೆ. ನೀವು ಇತರ ಬದ್ಧತೆಗಳು ಅಥವಾ ವೈಯಕ್ತಿಕ ಸನ್ನಿವೇಶಗಳನ್ನು ಹೊಂದಿರಬಹುದು ಎಂದು ನಾವು ಅರ್ಥಮಾಡಿಕೊಳ್ಳುತ್ತೇವೆ. ಭವಿಷ್ಯದಲ್ಲಿ ನಿಮ್ಮ CoC ಪ್ರಯಾಣವನ್ನು ಮುಂದುವರಿಸಲು ಬಯಸಿದರೆ, ದಯವಿಟ್ಟು {regLink} ನಲ್ಲಿ ನೋಂದಾಯಿಸಿ.\n\nಶುಭಾಶಯಗಳೊಂದಿಗೆ,\nCoC ನಿರ್ವಹಣಾ ತಂಡ",
      terminatedSubject: "CoC ಗುಂಪು ವಿಸರ್ಜಿಸಲಾಗಿದೆ - {groupName}",
      terminatedBody: "ಆತ್ಮೀಯ {name},\n\nನಿಮ್ಮ CoC ಗುಂಪು ({groupName}) ಕಾರ್ಯನಿರ್ವಹಿಸುತ್ತಿಲ್ಲದ ಕಾರಣ ವಿಸರ್ಜಿಸಲಾಗಿದೆ. ನಾವು ನಿಮ್ಮ ಪ್ರಯತ್ನಗಳನ್ನು ಅಂಗೀಕರಿಸುತ್ತೇವೆ.\n\nಇದು ದೋಷ ಎಂದು ನೀವು ಭಾವಿಸಿದರೆ ಮತ್ತು/ಅಥವಾ ನಿಮ್ಮ CoC ಪ್ರಯಾಣವನ್ನು ಮುಂದುವರಿಸಲು ಬಯಸಿದರೆ, ದಯವಿಟ್ಟು ಈ ಇಮೇಲ್‌ಗೆ ಪ್ರತ್ಯುತ್ತರಿಸಿ, ಅಥವಾ ನಿಮ್ಮ ಸಂಯೋಜಕರನ್ನು ಸಂಪರ್ಕಿಸಿ. ಪರ್ಯಾಯವಾಗಿ, ಹೊಸ ಗುಂಪಿಗಾಗಿ ನೀವು {regLink} ನಲ್ಲಿ ಮತ್ತೆ ನೋಂದಾಯಿಸಬಹುದು.\n\nಶುಭಾಶಯಗಳೊಂದಿಗೆ,\nCoC ನಿರ್ವಹಣಾ ತಂಡ",
      discontinuedSubject: "CoC ಭಾಗವಹಿಸುವಿಕೆ ನಿಲ್ಲಿಸಲಾಗಿದೆ - {groupName}",
      discontinuedBody: "ಆತ್ಮೀಯ {name},\n\nನೀವು ಅಧಿವೇಶನಗಳಲ್ಲಿ ಭಾಗವಹಿಸದ ಕಾರಣ CoC ಗುಂಪು ({groupName}) ಯಿಂದ ನಿಮ್ಮ ಸದಸ್ಯತ್ವವನ್ನು ರದ್ದುಪಡಿಸಿದ್ದೇವೆ. ನೀವು ಇತರ ಬದ್ಧತೆಗಳು ಅಥವಾ ವೈಯಕ್ತಿಕ ಪರಿಸ್ಥಿತಿಗಳನ್ನು ಹೊಂದಿರಬಹುದು ಎಂದು ನಾವು ಅರ್ಥಮಾಡಿಕೊಳ್ಳುತ್ತೇವೆ.\n\nನಿಮ್ಮ ನೋಂದಣಿ ರದ್ದುಪಡಿಸುವಿಕೆ ದೋಷ ಎಂದು ನೀವು ಭಾವಿಸಿದರೆ ಮತ್ತು/ಅಥವಾ ನಿಮ್ಮ CoC ಪ್ರಯಾಣವನ್ನು ಮುಂದುವರಿಸಲು ಬಯಸಿದರೆ, ದಯವಿಟ್ಟು ಈ ಇಮೇಲ್‌ಗೆ ಪ್ರತ್ಯುತ್ತರಿಸಿ, ಅಥವಾ ನಿಮ್ಮ ಸಂಯೋಜಕರನ್ನು ಸಂಪರ್ಕಿಸಿ. ಪರ್ಯಾಯವಾಗಿ, ನೀವು {regLink} ನಲ್ಲಿ ಮತ್ತೆ ನೋಂದಾಯಿಸಬಹುದು.\n\nಶುಭಾಶಯಗಳೊಂದಿಗೆ,\nCoC ನಿರ್ವಹಣಾ ತಂಡ"
    },
    Telugu: {
      closedSubject: "CoC గ్రూప్ మూసివేయబడింది - {groupName}",
      closedBodyActive: "ప్రియమైన {name},\n\nమీరు అన్ని సెషన్‌లను పూర్తి చేసినందున మీ CoC గ్రూప్ ({groupName}) ఇప్పుడు మూసివేయబడింది. మీ CoC ప్రయాణాన్ని విజయవంతంగా పూర్తి చేసినందుకు అభినందనలు! మీరు కొత్త గ్రూప్‌తో పునరావృతం చేయాలనుకుంటే, దయచేసి {regLink} వద్ద మళ్లీ నమోదు చేయండి.\n\nశుభాకాంక్షలతో,\nCoC నిర్వహణ బృందం",
      closedBodyInactive: "ప్రియమైన {name},\n\nగ్రూప్ అన్ని సెషన్‌లను పూర్తి చేసినందున మీ CoC గ్రూప్ ({groupName}) ఇప్పుడు మూసివేయబడింది. మీకు ఇతర బాధ్యతలు లేదా వ్యక్తిగత పరిస్థితులు ఉండవచ్చని మేము అర్థం చేసుకుంటున్నాము. భవిష్యత్తులో మీ CoC ప్రయాణాన్ని కొనసాగించాలనుకుంటే, దయచేసి {regLink} వద్ద నమోదు చేయండి.\n\nశుభాకాంక్షలతో,\nCoC నిర్వహణ బృందం",
      terminatedSubject: "CoC గ్రూప్ రద్దు చేయబడింది - {groupName}",
      terminatedBody: "ప్రియమైన {name},\n\nమీ CoC గ్రూప్ ({groupName}) పనిచేయడం లేదు కాబట్టి రద్దు చేయబడింది. మేము మీ ప్రయత్నాలను గుర్తిస్తున్నాము.\n\nఇది పొరపాటు అని మీరు భావిస్తే మరియు/లేదా మీ CoC ప్రయాణాన్ని కొనసాగించాలనుకుంటే, దయచేసి ఈ ఇమెయిల్‌కు ప్రత్యుత్తరం ఇవ్వండి, లేదా మీ సమన్వయకర్తతో సంప్రదించండి. ప్రత్యామ్నాయంగా, కొత్త గ్రూప్ కోసం మీరు {regLink} వద్ద మళ్లీ నమోదు చేసుకోవచ్చు.\n\nశుభాకాంక్షలతో,\nCoC నిర్వహణ బృందం",
      discontinuedSubject: "CoC భాగస్వామ్యం నిలిపివేయబడింది - {groupName}",
      discontinuedBody: "ప్రియమైన {name},\n\nమీరు సెషన్‌లలో చేరకపోవడంతో CoC గ్రూప్ ({groupName}) నుండి మీ సభ్యత్వాన్ని రద్దు చేసాము. మీకు ఇతర బాధ్యతలు లేదా వ్యక్తిగత పరిస్థితులు ఉండవచ్చని మేము అర్థం చేసుకుంటున్నాము.\n\nమీ రిజిస్ట్రేషన్ రద్దు చేయడం పొరపాటు అని మీరు భావిస్తే మరియు/లేదా మీ CoC ప్రయాణాన్ని కొనసాగించాలనుకుంటే, దయచేసి ఈ ఇమెయిల్‌కు ప్రత్యుత్తరం ఇవ్వండి, లేదా మీ సమన్వయకర్తతో సంప్రదించండి. ప్రత్యామ్నాయంగా, మీరు {regLink} వద్ద మళ్లీ నమోదు చేసుకోవచ్చు.\n\nశుభాకాంక్షలతో,\nCoC నిర్వహణ బృందం"
    }
  };
  
  return allLabels[language] || allLabels.English;
}

// Global helper: send discontinued participant email (used by acceptGroupSuggestions)
function sendDiscontinuedEmail(email, name, groupName, language, coordinatorEmail) {
  const labels = getLifecycleEmailLabels(language);
  const subject = labels.discontinuedSubject.replace('{groupName}', groupName);
  const body = labels.discontinuedBody
    .replace('{name}', name)
    .replace('{groupName}', groupName)
    .replace('{regLink}', "https://www.hcessentials.org/coc-registration-form");
  const emailOptions = { to: email, subject, body };
  if (coordinatorEmail && coordinatorEmail.trim()) {
    emailOptions.cc = coordinatorEmail;
  }
  MailApp.sendEmail(emailOptions);
}
