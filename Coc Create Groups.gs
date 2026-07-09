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
 * SCRIPT LOCK
 * Serializes admin mutations against Participants/Groups so a menu action
 * (suggest/accept/populate) can't interleave with a concurrent trigger run
 * (weekly lifecycle, discontinue-inactive) or with another admin's click.
 ************************************************/
function withScriptLock_(fn, timeoutMs) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(timeoutMs || 30000);
  } catch (err) {
    throw new Error("Another CoC admin operation is in progress. Please try again in a moment.");
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/************************************************
 * POPULATE PARTICIPANTS FROM CustomForm
 ************************************************/
function populateParticipantsFromCustomForm() {
  return withScriptLock_(populateParticipantsFromCustomForm_impl_);
}

function populateParticipantsFromCustomForm_impl_() {
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

function applyLanguageAdminReplyTo_(emailOptions, language) {
  if (!emailOptions || typeof emailOptions !== "object") return emailOptions;
  const adminEmail = String(getAdminEmailForLanguage(language) || "").trim();
  if (adminEmail) {
    emailOptions.replyTo = adminEmail;
  }
  return emailOptions;
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
 * - Send language-scoped admin summary email
 *
 * Use language-specific functions for triggers so each language can be
 * processed independently:
 * - weeklyLifecycleProcessingEnglish
 * - weeklyLifecycleProcessingTamil
 * - weeklyLifecycleProcessingHindi
 * - weeklyLifecycleProcessingKannada
 * - weeklyLifecycleProcessingTelugu
 ************************************************/
function weeklyLifecycleProcessing() {
  Logger.log("weeklyLifecycleProcessing() runs all languages. Prefer per-language trigger functions.");
  ["English", "Tamil", "Hindi", "Kannada", "Telugu"].forEach(lang => {
    weeklyLifecycleProcessingByLanguage_(lang);
  });
}

function weeklyLifecycleProcessingEnglish() { weeklyLifecycleProcessingByLanguage_("English"); }
function weeklyLifecycleProcessingTamil() { weeklyLifecycleProcessingByLanguage_("Tamil"); }
function weeklyLifecycleProcessingHindi() { weeklyLifecycleProcessingByLanguage_("Hindi"); }
function weeklyLifecycleProcessingKannada() { weeklyLifecycleProcessingByLanguage_("Kannada"); }
function weeklyLifecycleProcessingTelugu() { weeklyLifecycleProcessingByLanguage_("Telugu"); }

function weeklyLifecycleProcessingByLanguage_(language) {
  return withScriptLock_(() => weeklyLifecycleProcessingByLanguage_impl_(language));
}

function weeklyLifecycleProcessingByLanguage_impl_(language) {
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

  // Track changes for admin summary (single language run)
  const summary = {
    closed: [],        // [{groupName, count, coordinatorName}]
    terminated: [],    // [{groupName, count, coordinatorName}]
    discontinued: 0
  };

  const emailFailures = [];
  const emailStats = {
    participantAttempts: 0,
    participantSent: 0,
    participantFailed: 0,
    adminAttempts: 0,
    adminSent: 0,
    adminFailed: 0
  };

  const registerClosed = (groupName, count, coordinatorName) => {
    summary.closed.push({ groupName: groupName, count: count, coordinatorName: coordinatorName || "" });
  };
  const registerTerminated = (groupName, count, coordinatorName) => {
    summary.terminated.push({ groupName: groupName, count: count, coordinatorName: coordinatorName || "" });
  };
  const registerDiscontinued = () => {
    summary.discontinued++;
  };

  // Helpers: send lifecycle emails
  const REG_LINK = "https://www.hcessentials.org/coc-registration-form";
  const sendClosedEmail = (email, name, groupName, wasActive, language, coordinatorEmail) => {
    const labels = getLifecycleEmailLabels(language);
    const subject = labels.closedSubject.replace('{groupName}', groupName);
    const body = wasActive 
      ? labels.closedBodyActive.replace('{name}', name).replace('{groupName}', groupName).replace('{regLink}', REG_LINK)
      : labels.closedBodyInactive.replace('{name}', name).replace('{groupName}', groupName).replace('{regLink}', REG_LINK);
    const emailOptions = { to: email, subject, body };
    if (coordinatorEmail && coordinatorEmail.trim()) {
      emailOptions.cc = coordinatorEmail;
    }
    MailApp.sendEmail(applyLanguageAdminReplyTo_(emailOptions, language));
  };
  const sendTerminatedEmail = (email, name, groupName, language, coordinatorEmail, coordinatorPhone) => {
    const labels = getLifecycleEmailLabels(language);
    const subject = labels.terminatedSubject.replace('{groupName}', groupName);
    const coordinatorWhatsAppLabel = String(labels.coordinatorWhatsAppLabel || "Coordinator WhatsApp");
    const coordinatorContact = coordinatorPhone && String(coordinatorPhone).trim()
      ? ` (${coordinatorWhatsAppLabel}: ${String(coordinatorPhone).trim()})`
      : "";
    const body = labels.terminatedBody
      .replace('{name}', name)
      .replace('{groupName}', groupName)
      .replace('{regLink}', REG_LINK)
      .replace('{coordinatorContact}', coordinatorContact);
    const emailOptions = { to: email, subject, body };
    if (coordinatorEmail && coordinatorEmail.trim()) {
      emailOptions.cc = coordinatorEmail;
    }
    MailApp.sendEmail(applyLanguageAdminReplyTo_(emailOptions, language));
  };
  const sendDiscontinuedEmail = (email, name, groupName, language, coordinatorEmail) => {
    const labels = getLifecycleEmailLabels(language);
    const subject = labels.discontinuedSubject.replace('{groupName}', groupName);
    const body = labels.discontinuedBody.replace('{name}', name).replace('{groupName}', groupName).replace('{regLink}', REG_LINK);
    const emailOptions = { to: email, subject, body };
    if (coordinatorEmail && coordinatorEmail.trim()) {
      emailOptions.cc = coordinatorEmail;
    }
    MailApp.sendEmail(applyLanguageAdminReplyTo_(emailOptions, language));
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
      if (lang !== language) return;
      const coordinatorEmail = gIdx.CoordinatorEmail !== undefined ? String(gRow[gIdx.CoordinatorEmail] || "").trim() : "";
      const coordinatorName = gIdx.CoordinatorName !== undefined ? String(gRow[gIdx.CoordinatorName] || "").trim() : "";
      const members = listGroupParticipants(groupName);

      // Update group status
      gRow[gIdx.Status] = "Closed";
      gData[gi] = gRow;

      // Update members: AssignmentStatus = Completed, IsActive = FALSE, email based on original activity
      members.forEach((pRow, pi) => {
        const email = String(pRow[pIdx.Email] || "").trim();
        const name = String(pRow[pIdx.Name] || "").trim();
        const memberLang = String(pRow[pIdx.Language] || "").trim() || lang;
        const isCurrentlyAssigned = pIdx.AssignmentStatus !== undefined &&
          String(pRow[pIdx.AssignmentStatus] || "").trim().toLowerCase() === "assigned";
        const wasActive = !!toBool(pRow[pIdx.IsActive]);
        if (isCurrentlyAssigned && pIdx.AssignmentStatus !== undefined) {
          pRow[pIdx.AssignmentStatus] = "Completed";
        }
        if (pIdx.IsActive !== undefined) pRow[pIdx.IsActive] = false;
        if (isCurrentlyAssigned) {
          emailStats.participantAttempts++;
          try {
            sendClosedEmail(email, name, groupName, wasActive, memberLang, coordinatorEmail);
            emailStats.participantSent++;
          } catch (err) {
            emailStats.participantFailed++;
            emailFailures.push({ type: "Closed group email", lang, group: groupName, email, name, reason: err.message });
          }
        }
      });

      // Register summary
      registerClosed(groupName, members.length, coordinatorName);
    }
  });

  // 2) Terminate Inactive groups -> Terminated
  gData.forEach((gRow, gi) => {
    const status = String(gRow[gIdx.Status] || "").trim();
    if (status === "Inactive") {
      const groupName = String(gRow[gIdx.GroupName] || "").trim();
      const lang = String(gRow[gIdx.Language] || "").trim();
      if (lang !== language) return;
      const coordinatorEmail = String(gRow[gIdx.CoordinatorEmail] || "").trim();
      const coordinatorName = gIdx.CoordinatorName !== undefined ? String(gRow[gIdx.CoordinatorName] || "").trim() : "";
      const members = listGroupParticipants(groupName);
      let coordinatorPhone = gIdx.CoordinatorWhatsApp !== undefined
        ? String(gRow[gIdx.CoordinatorWhatsApp] || "").trim()
        : "";

      // Fallback: derive coordinator phone from group participants if group row does not have it.
      if (!coordinatorPhone && pIdx.IsGroupCoordinator !== undefined && pIdx.WhatsApp !== undefined) {
        const coordinatorMember = members.find(m => toBool(m[pIdx.IsGroupCoordinator]));
        if (coordinatorMember) {
          coordinatorPhone = String(coordinatorMember[pIdx.WhatsApp] || "").trim();
        }
      }

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
        emailStats.participantAttempts++;
        try {
          sendTerminatedEmail(email, name, groupName, memberLang, coordinatorEmail, coordinatorPhone);
          emailStats.participantSent++;
        } catch (err) {
          emailStats.participantFailed++;
          emailFailures.push({ type: "Terminated group email", lang, group: groupName, email, name, reason: err.message });
        }
        registerDiscontinued();
      });

      // Register summary
      registerTerminated(groupName, members.length, coordinatorName);
    }
  });



  // Persist changes
  gSheet.getRange(2, 1, gData.length, gHeaders.length).setValues(gData);
  pSheet.getRange(2, 1, pData.length, pHeaders.length).setValues(pData);

  // Update Groups and Dashboard before sending emails
  updateAdminDashboard();

  // Send admin summary for this language
  const props = PropertiesService.getScriptProperties();
  const masterUrl = String(props.getProperty('MASTER_SHEET_URL') || '').trim();
  const adminEmailMap = getAdminEmailMapFromMaster();
  const adminEmail = adminEmailMap[language] || getAdminEmailForLanguage(language);
  const closed = summary.closed;
  const terminated = summary.terminated;
  const discCount = summary.discontinued;
  const failuresForLang = emailFailures.filter(f => f.lang === language);
  const changesExist = closed.length || terminated.length || discCount || failuresForLang.length;
  if (adminEmail && changesExist) {
    const subject = `CoC Weekly Lifecycle Summary - ${language}`;
    let lines = [];
    lines.push(...buildLifecycleSummaryIntroLines_(language, closed.length, terminated.length, discCount));
    lines.push("");
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

    if (closed.length || terminated.length) {
      lines.push("");
      lines.push("WhatsApp message for coordinators:");
      lines.push(buildLifecycleWhatsAppMessage_(language, closed, terminated));
    }

    if (failuresForLang.length) {
      lines.push("");
      lines.push("Email delivery issues:");
      failuresForLang.forEach(f => {
        const who = [f.name, f.email].filter(Boolean).join(" | ") || "Unknown";
        const grp = f.group ? ` [${f.group}]` : "";
        lines.push(`- ${f.type}${grp}: ${who} - ${f.reason}`);
      });
    }
    if (masterUrl) {
      lines.push("");
      lines.push(`CoC Master sheet: ${masterUrl}`);
    }
    const body = lines.join("\n");
    emailStats.adminAttempts++;
    try {
      MailApp.sendEmail(applyLanguageAdminReplyTo_({ to: adminEmail, subject, body }, language));
      emailStats.adminSent++;
    } catch (err) {
      emailStats.adminFailed++;
      emailFailures.push({ type: "Admin summary email", lang: language, email: adminEmail, reason: err.message });
    }
  }

  Logger.log(`[${language}] Weekly Lifecycle Processing Email Summary:` +
    ` Participants - Attempts: ${emailStats.participantAttempts}, Sent: ${emailStats.participantSent}, Failed: ${emailStats.participantFailed};` +
    ` Admin - Attempts: ${emailStats.adminAttempts}, Sent: ${emailStats.adminSent}, Failed: ${emailStats.adminFailed}`);

  if (emailFailures.length) {
    Logger.log(`Email send failures during weeklyLifecycleProcessingByLanguage_ (${language}):`);
    emailFailures.forEach(f => {
      const grp = f.group ? ` [${f.group}]` : "";
      Logger.log(`- ${f.lang}: ${f.type}${grp} -> ${f.email || "(no email)"} (${f.reason})`);
    });
  } else if (emailStats.participantAttempts > 0 || emailStats.adminAttempts > 0) {
    Logger.log(`[${language}] All emails sent successfully - no failures reported.`);
  } else {
    Logger.log(`[${language}] No emails were attempted to be sent.`);
  }
}

/************************************************
 * DISCONTINUE INDIVIDUALLY-INACTIVE MEMBERS
 * - The coordinator status update form lets a coordinator mark a single
 *   member IsActive=false without changing their group's status. Until
 *   now nothing ever turned that into an actual discontinue - it only
 *   happened in bulk when the whole group went Inactive -> Terminated.
 * - This job finds Assigned, IsActive=false participants whose group is
 *   still Active, sets AssignmentStatus=Discontinued, emails the
 *   participant with their coordinator CC'd, and sends the language
 *   admin a summary after every run.
 * - Groups that are Inactive/Terminated/Completed/Closed are left alone
 *   here since weeklyLifecycleProcessingByLanguage_ already handles their
 *   members in bulk; processing them here too would double-email people.
 *
 * Use language-specific functions for triggers so each language can be
 * processed independently:
 * - discontinueInactiveMembersEnglish
 * - discontinueInactiveMembersTamil
 * - discontinueInactiveMembersHindi
 * - discontinueInactiveMembersKannada
 * - discontinueInactiveMembersTelugu
 ************************************************/
function discontinueInactiveMembers() {
  Logger.log("discontinueInactiveMembers() runs all languages. Prefer per-language trigger functions.");
  ["English", "Tamil", "Hindi", "Kannada", "Telugu"].forEach(lang => {
    discontinueInactiveMembersByLanguage_(lang);
  });
}

function discontinueInactiveMembersEnglish() { discontinueInactiveMembersByLanguage_("English"); }
function discontinueInactiveMembersTamil() { discontinueInactiveMembersByLanguage_("Tamil"); }
function discontinueInactiveMembersHindi() { discontinueInactiveMembersByLanguage_("Hindi"); }
function discontinueInactiveMembersKannada() { discontinueInactiveMembersByLanguage_("Kannada"); }
function discontinueInactiveMembersTelugu() { discontinueInactiveMembersByLanguage_("Telugu"); }

function discontinueInactiveMembersByLanguage_(language) {
  return withScriptLock_(() => discontinueInactiveMembersByLanguage_impl_(language));
}

function discontinueInactiveMembersByLanguage_impl_(language) {
  const pSheet = getSheet("Participants");
  const gSheet = getSheet("Groups");

  const pData = pSheet.getDataRange().getValues();
  const gData = gSheet.getDataRange().getValues();
  const pHeaders = pData.shift();
  const gHeaders = gData.shift();
  const pIdx = indexMap(pHeaders);
  const gIdx = indexMap(gHeaders);

  if (pIdx.Language === undefined || pIdx.AssignmentStatus === undefined || pIdx.IsActive === undefined || pIdx.AssignedGroup === undefined) {
    Logger.log(`[${language}] Participants sheet missing required columns; skipping discontinueInactiveMembersByLanguage_.`);
    return;
  }

  // Only groups still Active are in scope - Inactive/Terminated/Completed/
  // Closed groups are handled in bulk by weeklyLifecycleProcessingByLanguage_.
  const activeGroupsByName = {};
  gData.forEach(r => {
    if (gIdx.GroupName === undefined) return;
    const status = gIdx.Status !== undefined ? String(r[gIdx.Status] || "").trim() : "";
    if (status !== "Active") return;
    const name = String(r[gIdx.GroupName] || "").trim();
    if (!name) return;
    activeGroupsByName[name.toLowerCase()] = {
      groupName: name,
      coordinatorName: gIdx.CoordinatorName !== undefined ? String(r[gIdx.CoordinatorName] || "").trim() : "",
      coordinatorEmail: gIdx.CoordinatorEmail !== undefined ? String(r[gIdx.CoordinatorEmail] || "").trim() : ""
    };
  });

  const discontinued = []; // [{name, email, groupName, coordinatorName}]
  const emailFailures = [];

  pData.forEach((pRow, pi) => {
    if (String(pRow[pIdx.Language] || "").trim() !== language) return;
    if (String(pRow[pIdx.AssignmentStatus] || "").trim() !== "Assigned") return;
    if (toBool(pRow[pIdx.IsActive])) return;
    if (pIdx.IsGroupCoordinator !== undefined && toBool(pRow[pIdx.IsGroupCoordinator])) return; // never auto-discontinue a coordinator

    const groupName = String(pRow[pIdx.AssignedGroup] || "").trim();
    const group = activeGroupsByName[groupName.toLowerCase()];
    if (!group) return; // group isn't Active (already handled elsewhere) or not found

    const email = pIdx.Email !== undefined ? String(pRow[pIdx.Email] || "").trim() : "";
    const name = pIdx.Name !== undefined ? String(pRow[pIdx.Name] || "").trim() : "";

    pRow[pIdx.AssignmentStatus] = "Discontinued";
    pData[pi] = pRow;

    try {
      sendDiscontinuedEmail(email, name, group.groupName, language, group.coordinatorEmail);
    } catch (err) {
      emailFailures.push({ name, email, groupName: group.groupName, reason: err.message });
    }

    discontinued.push({
      name,
      email,
      groupName: group.groupName,
      coordinatorName: group.coordinatorName || "(no coordinator on file)"
    });
  });

  if (discontinued.length) {
    pSheet.getRange(2, 1, pData.length, pHeaders.length).setValues(pData);
    updateAdminDashboard();
  }

  // Admin summary is sent after every run, even when nothing changed, so a
  // missed or broken trigger is noticeable rather than silent.
  const adminEmailMap = getAdminEmailMapFromMaster();
  const adminEmail = adminEmailMap[language] || getAdminEmailForLanguage(language);
  if (adminEmail) {
    const subject = `CoC Weekly Inactive Member Discontinuation - ${language}`;
    const lines = [];
    lines.push(`Weekly inactive-member discontinuation run for ${language}.`);
    lines.push(`Members discontinued this run: ${discontinued.length}`);
    lines.push("");
    if (discontinued.length) {
      lines.push("Details (name | group | coordinator):");
      discontinued.forEach(d => {
        lines.push(`- ${d.name || "(no name)"} | ${d.groupName} | ${d.coordinatorName}`);
      });
    } else {
      lines.push("No members met the discontinue criteria this run.");
    }
    if (emailFailures.length) {
      lines.push("");
      lines.push("Participant email delivery issues:");
      emailFailures.forEach(f => {
        lines.push(`- ${f.name || "(no name)"} | ${f.email || "(no email)"} | ${f.groupName} - ${f.reason}`);
      });
    }
    try {
      MailApp.sendEmail(applyLanguageAdminReplyTo_({ to: adminEmail, subject, body: lines.join("\n") }, language));
    } catch (err) {
      Logger.log(`Failed to send discontinue summary email for ${language}: ${err.message}`);
    }
  } else {
    Logger.log(`[${language}] No admin email configured; skipping discontinue summary email.`);
  }

  Logger.log(`[${language}] discontinueInactiveMembersByLanguage_: ${discontinued.length} discontinued, ${emailFailures.length} participant email failures.`);
}

/************************************************
 * BIWEEKLY STALE GROUP CHECK
 * - Scans Active groups per language and flags any whose Groups.LastUpdated
 *   (falling back to GroupCreationDate if a group has never been updated)
 *   is older than STALE_GROUP_THRESHOLD_DAYS.
 * - Emails the coordinator, in the group's language, asking them to submit
 *   a status update via the coordinator form, and warns that continued
 *   inactivity may lead to closure in the future.
 * - This job does NOT change any group's Status or close/terminate
 *   anything - it only sends a reminder. Closing stale groups automatically
 *   is a possible future enhancement, not implemented here.
 *
 * Use language-specific functions for triggers so each language can be
 * processed independently:
 * - staleGroupCheckEnglish
 * - staleGroupCheckTamil
 * - staleGroupCheckHindi
 * - staleGroupCheckKannada
 * - staleGroupCheckTelugu
 ************************************************/
const STALE_GROUP_THRESHOLD_DAYS = 30;
const COORDINATOR_UPDATE_FORM_LINK = "https://www.hcessentials.org/coc-coordinator-update";

function staleGroupCheck() {
  Logger.log("staleGroupCheck() runs all languages. Prefer per-language trigger functions.");
  ["English", "Tamil", "Hindi", "Kannada", "Telugu"].forEach(lang => {
    staleGroupCheckByLanguage_(lang);
  });
}

function staleGroupCheckEnglish() { staleGroupCheckByLanguage_("English"); }
function staleGroupCheckTamil() { staleGroupCheckByLanguage_("Tamil"); }
function staleGroupCheckHindi() { staleGroupCheckByLanguage_("Hindi"); }
function staleGroupCheckKannada() { staleGroupCheckByLanguage_("Kannada"); }
function staleGroupCheckTelugu() { staleGroupCheckByLanguage_("Telugu"); }

function staleGroupCheckByLanguage_(language) {
  return withScriptLock_(() => staleGroupCheckByLanguage_impl_(language));
}

function staleGroupCheckByLanguage_impl_(language) {
  const gSheet = getSheet("Groups");
  const gData = gSheet.getDataRange().getValues();
  const gHeaders = gData.shift();
  const gIdx = indexMap(gHeaders);

  if (gIdx.Language === undefined || gIdx.Status === undefined || gIdx.GroupName === undefined || gIdx.LastUpdated === undefined) {
    Logger.log(`[${language}] Groups sheet missing required columns; skipping staleGroupCheckByLanguage_.`);
    return;
  }

  const scriptTz = Session.getScriptTimeZone();
  const now = new Date();
  const thresholdMs = STALE_GROUP_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

  const flagged = []; // [{groupName, coordinatorName, coordinatorEmail, lastUpdatedText}]
  const emailFailures = [];
  const skippedNoEmail = []; // [{groupName, coordinatorName, lastUpdatedText}] - stale but no CoordinatorEmail on file

  gData.forEach(r => {
    if (String(r[gIdx.Language] || "").trim() !== language) return;
    // Only groups still Active can go stale; Inactive/Terminated/Completed/
    // Closed groups are out of scope for this reminder.
    if (String(r[gIdx.Status] || "").trim() !== "Active") return;

    const lastUpdatedRaw = r[gIdx.LastUpdated];
    const creationRaw = gIdx.GroupCreationDate !== undefined ? r[gIdx.GroupCreationDate] : null;
    const anchorRaw = lastUpdatedRaw || creationRaw;
    const anchorDate = anchorRaw instanceof Date ? anchorRaw : (anchorRaw ? new Date(anchorRaw) : null);
    const isStale = !anchorDate || Number.isNaN(anchorDate.getTime()) || (now.getTime() - anchorDate.getTime()) >= thresholdMs;
    if (!isStale) return;

    const groupName = String(r[gIdx.GroupName] || "").trim();
    if (!groupName) return; // nothing to reference in the notification

    const coordinatorName = gIdx.CoordinatorName !== undefined ? String(r[gIdx.CoordinatorName] || "").trim() : "";
    const coordinatorEmail = gIdx.CoordinatorEmail !== undefined ? String(r[gIdx.CoordinatorEmail] || "").trim() : "";

    const lastUpdatedText = anchorDate && !Number.isNaN(anchorDate.getTime())
      ? Utilities.formatDate(anchorDate, scriptTz, "yyyy-MM-dd")
      : "N/A";

    if (!coordinatorEmail) {
      skippedNoEmail.push({ groupName, coordinatorName, lastUpdatedText });
      return;
    }

    const labels = getStaleGroupCheckEmailLabels(language);
    const subject = labels.subject.replace('{groupName}', groupName);
    const body = labels.body
      .replace('{coordinatorName}', coordinatorName || labels.fallbackCoordinatorName)
      .replace(/\{groupName\}/g, groupName)
      .replace('{lastUpdatedText}', lastUpdatedText)
      .replace('{formLink}', COORDINATOR_UPDATE_FORM_LINK);

    try {
      MailApp.sendEmail(applyLanguageAdminReplyTo_({ to: coordinatorEmail, subject, body }, language));
    } catch (err) {
      emailFailures.push({ groupName, coordinatorEmail, reason: err.message });
    }

    flagged.push({ groupName, coordinatorName, coordinatorEmail, lastUpdatedText });
  });

  // Admin summary is sent after every run, even when nothing changed, so a
  // missed or broken trigger is noticeable rather than silent.
  const adminEmail = getAdminEmailForLanguage(language);
  if (adminEmail) {
    const subject = `CoC Biweekly Stale Group Check - ${language}`;
    const lines = [];
    lines.push(`Biweekly stale-group check for ${language}: groups with no update in ${STALE_GROUP_THRESHOLD_DAYS}+ days.`);
    lines.push(`Groups flagged and emailed this run: ${flagged.length}`);
    lines.push("");
    if (flagged.length) {
      lines.push("Details (group | coordinator | last updated):");
      flagged.forEach(f => {
        lines.push(`- ${f.groupName} | ${f.coordinatorName || "(no coordinator name)"} | ${f.lastUpdatedText}`);
      });
      lines.push("");
      lines.push("WhatsApp message for coordinators:");
      lines.push(buildStaleGroupCheckWhatsAppMessage_(language, flagged));
    } else {
      lines.push("No groups met the stale criteria this run.");
    }
    if (emailFailures.length) {
      lines.push("");
      lines.push("Coordinator email delivery issues:");
      emailFailures.forEach(f => {
        lines.push(`- ${f.groupName} | ${f.coordinatorEmail || "(no email)"} - ${f.reason}`);
      });
    }
    if (skippedNoEmail.length) {
      lines.push("");
      lines.push("Stale but skipped - no CoordinatorEmail on file (please add one so these can be reminded):");
      skippedNoEmail.forEach(s => {
        lines.push(`- ${s.groupName} | ${s.coordinatorName || "(no coordinator name)"} | ${s.lastUpdatedText}`);
      });
    }
    try {
      MailApp.sendEmail(applyLanguageAdminReplyTo_({ to: adminEmail, subject, body: lines.join("\n") }, language));
    } catch (err) {
      Logger.log(`Failed to send stale-group-check summary email for ${language}: ${err.message}`);
    }
  } else {
    Logger.log(`[${language}] No admin email configured; skipping stale-group-check summary email.`);
  }

  Logger.log(`[${language}] staleGroupCheckByLanguage_: ${flagged.length} flagged, ${emailFailures.length} coordinator email failures, ${skippedNoEmail.length} skipped (no coordinator email).`);
}

function getStaleGroupCheckEmailLabels(language) {
  const allLabels = {
    English: {
      subject: "Action Needed: Weekly Status Update for {groupName}",
      fallbackCoordinatorName: "Coordinator",
      body: "Dear {coordinatorName},\n\nWe have not received a status update for your CoC group ({groupName}) since {lastUpdatedText}. Please submit your group's weekly status using this form:\n\n{formLink}\n\nWe are not closing any groups at this time, but groups that continue to go without a status update may be closed in the future. Please take a moment to submit an update so we know your group ({groupName}) is still active.\n\nWith best wishes,\nCoC Admin Team"
    },
    Tamil: {
      subject: "செயல் தேவை: {groupName} க்கான வாராந்திர நிலை புதுப்பிப்பு",
      fallbackCoordinatorName: "ஒருங்கிணைப்பாளர்",
      body: "அன்புள்ள {coordinatorName},\n\nஉங்கள் CoC குழுவிற்கான ({groupName}) நிலை புதுப்பிப்பை {lastUpdatedText} முதல் நாங்கள் பெறவில்லை. தயவுசெய்து கீழே உள்ள படிவத்தின் மூலம் உங்கள் குழுவின் வாராந்திர நிலையை சமர்ப்பிக்கவும்:\n\n{formLink}\n\nதற்போது நாங்கள் எந்த குழுவையும் மூடவில்லை, ஆனால் தொடர்ந்து நிலை புதுப்பிப்பு இல்லாத குழுக்கள் எதிர்காலத்தில் மூடப்படக்கூடும். உங்கள் குழு ({groupName}) இன்னும் செயலில் உள்ளது என்பதை எங்களுக்குத் தெரிவிக்க தயவுசெய்து புதுப்பிப்பை சமர்ப்பிக்கவும்.\n\nநல்வாழ்த்துகளுடன்,\nCoC நிர்வாகக் குழு"
    },
    Hindi: {
      subject: "कार्रवाई आवश्यक: {groupName} के लिए साप्ताहिक स्थिति अपडेट",
      fallbackCoordinatorName: "समन्वयक",
      body: "प्रिय {coordinatorName},\n\nहमें आपके CoC समूह ({groupName}) के लिए {lastUpdatedText} से कोई स्थिति अपडेट प्राप्त नहीं हुआ है। कृपया नीचे दिए गए फॉर्म के माध्यम से अपने समूह की साप्ताहिक स्थिति सबमिट करें:\n\n{formLink}\n\nहम फिलहाल किसी भी समूह को बंद नहीं कर रहे हैं, लेकिन जो समूह लगातार स्थिति अपडेट के बिना रहते हैं उन्हें भविष्य में बंद किया जा सकता है। कृपया अपडेट सबमिट करें ताकि हमें पता चले कि आपका समूह ({groupName}) अभी भी सक्रिय है।\n\nशुभकामनाओं के साथ,\nCoC प्रशासन टीम"
    },
    Kannada: {
      subject: "ಕ್ರಮ ಅಗತ್ಯವಿದೆ: {groupName} ಗಾಗಿ ವಾರದ ಸ್ಥಿತಿ ನವೀಕರಣ",
      fallbackCoordinatorName: "ಸಂಯೋಜಕರು",
      body: "ಆತ್ಮೀಯ {coordinatorName},\n\nನಿಮ್ಮ CoC ಗುಂಪಿಗೆ ({groupName}) {lastUpdatedText} ರಿಂದ ಯಾವುದೇ ಸ್ಥಿತಿ ನವೀಕರಣ ನಮಗೆ ಸಿಕ್ಕಿಲ್ಲ. ದಯವಿಟ್ಟು ಕೆಳಗಿನ ಫಾರ್ಮ್ ಮೂಲಕ ನಿಮ್ಮ ಗುಂಪಿನ ವಾರದ ಸ್ಥಿತಿಯನ್ನು ಸಲ್ಲಿಸಿ:\n\n{formLink}\n\nಪ್ರಸ್ತುತ ನಾವು ಯಾವುದೇ ಗುಂಪನ್ನು ಮುಚ್ಚುತ್ತಿಲ್ಲ, ಆದರೆ ಸ್ಥಿತಿ ನವೀಕರಣ ಇಲ್ಲದೆ ಮುಂದುವರಿಯುವ ಗುಂಪುಗಳನ್ನು ಭವಿಷ್ಯದಲ್ಲಿ ಮುಚ್ಚಬಹುದು. ನಿಮ್ಮ ಗುಂಪು ({groupName}) ಇನ್ನೂ ಸಕ್ರಿಯವಾಗಿದೆ ಎಂದು ನಮಗೆ ತಿಳಿಸಲು ದಯವಿಟ್ಟು ನವೀಕರಣವನ್ನು ಸಲ್ಲಿಸಿ.\n\nಶುಭಾಶಯಗಳೊಂದಿಗೆ,\nCoC ನಿರ್ವಹಣಾ ತಂಡ"
    },
    Telugu: {
      subject: "చర్య అవసరం: {groupName} కోసం వారపు స్థితి నవీకరణ",
      fallbackCoordinatorName: "సమన్వయకర్త",
      body: "ప్రియమైన {coordinatorName},\n\nమీ CoC గ్రూప్ ({groupName}) కోసం {lastUpdatedText} నుండి మాకు స్థితి నవీకరణ అందలేదు. దయచేసి క్రింది ఫారమ్ ద్వారా మీ గ్రూప్ యొక్క వారపు స్థితిని సమర్పించండి:\n\n{formLink}\n\nప్రస్తుతం మేము ఏ గ్రూప్‌ను మూసివేయడం లేదు, కానీ నిరంతరం స్థితి నవీకరణ లేని గ్రూప్‌లు భవిష్యత్తులో మూసివేయబడవచ్చు. మీ గ్రూప్ ({groupName}) ఇప్పటికీ యాక్టివ్‌గా ఉందని మాకు తెలియజేయడానికి దయచేసి నవీకరణను సమర్పించండి.\n\nశుభాకాంక్షలతో,\nCoC నిర్వహణ బృందం"
    }
  };

  return allLabels[language] || allLabels.English;
}

function buildLifecycleSummaryIntroLines_(language, closedCount, terminatedCount, discontinuedCount) {
  const templates = {
    English: [
      "This weekly lifecycle process keeps group records accurate and ensures participants are informed based on current group status.",
      `For ${language}, this report tells you which groups were closed or terminated, how many participants were updated (including discontinued: ${discontinuedCount}), and where manual follow-up may be needed.`,
      "Use this summary to quickly validate actions, correct mistakes early, and communicate updates to coordinators."
    ],
    Tamil: [
      "இந்த வார lifecycle செயல்முறை குழு நிலைகளை சரியாக புதுப்பித்து, தற்போதைய நிலைக்கு ஏற்ப பங்கேற்பாளர்களுக்கு தகவல் அனுப்ப உதவுகிறது.",
      `${language} மொழிக்கான இந்த அறிக்கை எந்த குழுக்கள் மூடப்பட்டன அல்லது நிறுத்தப்பட்டன, எத்தனை பங்கேற்பாளர்கள் புதுப்பிக்கப்பட்டனர் (discontinued: ${discontinuedCount}) மற்றும் எங்கு கைமுறை பின்தொடர்பு தேவை என்பதை காட்டுகிறது.`,
      "இந்த சுருக்கத்தை பயன்படுத்தி நடவடிக்கைகளை சரிபார்த்து, பிழைகளை விரைவாக திருத்தி, ஒருங்கிணைப்பாளர்களுக்கு தெளிவாக தகவல் பகிரலாம்."
    ],
    Hindi: [
      "यह साप्ताहिक lifecycle प्रक्रिया समूह स्थिति को सही रखती है और वर्तमान स्थिति के आधार पर प्रतिभागियों को सूचित करती है।",
      `${language} के लिए यह रिपोर्ट बताती है कि कौन से समूह बंद या समाप्त किए गए, कितने प्रतिभागी अपडेट हुए (discontinued: ${discontinuedCount}), और कहाँ मैन्युअल फॉलो-अप आवश्यक है।`,
      "इस सारांश का उपयोग करके आप कार्रवाई सत्यापित कर सकते हैं, त्रुटियों को जल्दी सुधार सकते हैं, और समन्वयकों को स्पष्ट अपडेट दे सकते हैं।"
    ],
    Kannada: [
      "ಈ ವಾರದ lifecycle ಪ್ರಕ್ರಿಯೆ ಗುಂಪು ಸ್ಥಿತಿಯನ್ನು ಸರಿಯಾಗಿ ಉಳಿಸಿ, ಪ್ರಸ್ತುತ ಸ್ಥಿತಿಗೆ ಅನುಗುಣವಾಗಿ ಭಾಗವಹಿಸುವವರಿಗೆ ಮಾಹಿತಿ ಕಳುಹಿಸಲು ಸಹಾಯ ಮಾಡುತ್ತದೆ.",
      `${language} ಭಾಷೆಗೆ ಈ ವರದಿ ಯಾವ ಗುಂಪುಗಳು ಮುಚ್ಚಲ್ಪಟ್ಟಿವೆ ಅಥವಾ ನಿಲ್ಲಿಸಲ್ಪಟ್ಟಿವೆ, ಎಷ್ಟು ಭಾಗವಹಿಸುವವರು ಅಪ್ಡೇಟ್ ಆಗಿದ್ದಾರೆ (discontinued: ${discontinuedCount}), ಹಾಗೂ ಎಲ್ಲಿಗೆ ಕೈಯಾರೆ ಫಾಲೋ-ಅಪ್ ಬೇಕು ಎಂಬುದನ್ನು ತೋರಿಸುತ್ತದೆ.`,
      "ಈ ಸಾರಾಂಶದ ಮೂಲಕ ಕ್ರಮಗಳನ್ನು ಪರಿಶೀಲಿಸಿ, ದೋಷಗಳನ್ನು ಬೇಗ ಸರಿಪಡಿಸಿ, ಸಂಯೋಜಕರಿಗೆ ಸ್ಪಷ್ಟವಾಗಿ ಮಾಹಿತಿ ಹಂಚಬಹುದು."
    ],
    Telugu: [
      "ఈ వారపు lifecycle ప్రక్రియ గ్రూప్ స్థితులను సరైన విధంగా ఉంచి, ప్రస్తుత స్థితి ఆధారంగా భాగస్వాములకు సమాచారం పంపడంలో సహాయపడుతుంది.",
      `${language} కోసం ఈ నివేదిక ఏ గ్రూపులు మూసివేయబడ్డాయి లేదా రద్దు చేయబడ్డాయి, ఎంత మంది భాగస్వాములు అప్డేట్ అయ్యారు (discontinued: ${discontinuedCount}), ఇంకా ఎక్కడ మాన్యువల్ ఫాలో-అప్ అవసరమో చూపిస్తుంది.`,
      "ఈ సారాంశంతో మీరు చర్యలను త్వరగా ధృవీకరించి, తప్పులను సరిదిద్దుకుని, సమన్వయకర్తలకు స్పష్టమైన అప్‌డేట్స్ ఇవ్వవచ్చు."
    ]
  };

  return templates[language] || templates.English;
}

function buildLifecycleWhatsAppMessage_(language, closedGroups, terminatedGroups) {
  const closedLines = closedGroups.map(g => `- ${g.groupName}${g.coordinatorName ? ` (${g.coordinatorName})` : ""}`);
  const terminatedLines = terminatedGroups.map(g => `- ${g.groupName}${g.coordinatorName ? ` (${g.coordinatorName})` : ""}`);

  const templates = {
    English: {
      intro: "Dear Coordinators, weekly lifecycle updates have been completed.",
      closedTitle: "Closed groups (completed all sessions):",
      terminatedTitle: "Terminated groups (inactive/not functioning):",
      correction: "If any correction is needed, please contact me directly or message in this group."
    },
    Tamil: {
      intro: "அன்புடையீர் ஒருங்கிணைப்பாளர்களே, இந்த வார lifecycle updates முடிக்கப்பட்டது.",
      closedTitle: "மூடப்பட்ட குழுக்கள் (அனைத்து அமர்வுகளும் முடிந்ததால்):",
      terminatedTitle: "நிறுத்தப்பட்ட குழுக்கள் (செயல்படாமல் இருந்ததால்):",
      correction: "ஏதேனும் திருத்தம் வேண்டுமெனில், எனக்கு நேரடியாக தொடர்பு கொள்ளவும் அல்லது இந்த குழுவில் செய்தி இடவும்."
    },
    Hindi: {
      intro: "प्रिय समन्वयकों, इस सप्ताह के lifecycle updates पूरे कर दिए गए हैं।",
      closedTitle: "बंद किए गए समूह (सभी सत्र पूर्ण):",
      terminatedTitle: "समाप्त किए गए समूह (निष्क्रिय/कार्य नहीं कर रहे):",
      correction: "यदि कोई सुधार चाहिए, तो कृपया मुझसे सीधे संपर्क करें या इस समूह में संदेश करें।"
    },
    Kannada: {
      intro: "ಪ್ರಿಯ ಸಂಯೋಜಕರೇ, ಈ ವಾರದ lifecycle updates ಪೂರ್ಣಗೊಂಡಿವೆ.",
      closedTitle: "ಮುಚ್ಚಲಾದ ಗುಂಪುಗಳು (ಎಲ್ಲಾ ಅಧಿವೇಶನಗಳು ಪೂರ್ಣ):",
      terminatedTitle: "ನಿಲ್ಲಿಸಲಾದ ಗುಂಪುಗಳು (ನಿಷ್ಕ್ರಿಯ/ಕಾರ್ಯನಿರ್ವಹಿಸದ):",
      correction: "ಯಾವುದೇ ತಿದ್ದುಪಡಿ ಬೇಕಿದ್ದರೆ, ದಯವಿಟ್ಟು ನನಗೆ ನೇರವಾಗಿ ಸಂಪರ್ಕಿಸಿ ಅಥವಾ ಈ ಗುಂಪಿನಲ್ಲಿ ಸಂದೇಶಿಸಿ."
    },
    Telugu: {
      intro: "ప్రియమైన సమన్వయకర్తలారా, ఈ వారపు lifecycle updates పూర్తి అయ్యాయి.",
      closedTitle: "మూసివేసిన గ్రూపులు (అన్ని సెషన్లు పూర్తయ్యాయి):",
      terminatedTitle: "రద్దు చేసిన గ్రూపులు (నిష్క్రియ/పనిచేయని):",
      correction: "ఏదైనా సరిదిద్దాల్సి ఉంటే, దయచేసి నన్ను నేరుగా సంప్రదించండి లేదా ఈ గ్రూప్‌లో మెసేజ్ చేయండి."
    }
  };

  const t = templates[language] || templates.English;
  const lines = [t.intro];

  if (closedLines.length) {
    lines.push("");
    lines.push(t.closedTitle);
    lines.push(...closedLines);
  }

  if (terminatedLines.length) {
    lines.push("");
    lines.push(t.terminatedTitle);
    lines.push(...terminatedLines);
  }

  lines.push("");
  lines.push(t.correction);

  return lines.join("\n");
}

function buildStaleGroupCheckWhatsAppMessage_(language, flaggedGroups) {
  const groupLines = flaggedGroups.map(g => `- ${g.groupName}${g.coordinatorName ? ` (${g.coordinatorName})` : ""}`);

  const templates = {
    English: {
      intro: `Dear Coordinators, the following groups have not submitted a status update in over ${STALE_GROUP_THRESHOLD_DAYS} days. Please submit your status here: ${COORDINATOR_UPDATE_FORM_LINK}`,
      listTitle: "Groups needing a status update:",
      outro: "We are not closing any groups right now, but groups that continue without an update may be closed in the future. If any correction is needed, please contact me directly or message in this group."
    },
    Tamil: {
      intro: `அன்புடையீர் ஒருங்கிணைப்பாளர்களே, பின்வரும் குழுக்கள் ${STALE_GROUP_THRESHOLD_DAYS} நாட்களுக்கும் மேலாக நிலை புதுப்பிப்பை சமர்ப்பிக்கவில்லை. தயவுசெய்து உங்கள் நிலையை இங்கே சமர்ப்பிக்கவும்: ${COORDINATOR_UPDATE_FORM_LINK}`,
      listTitle: "நிலை புதுப்பிப்பு தேவைப்படும் குழுக்கள்:",
      outro: "தற்போது நாங்கள் எந்த குழுவையும் மூடவில்லை, ஆனால் தொடர்ந்து புதுப்பிப்பு இல்லாத குழுக்கள் எதிர்காலத்தில் மூடப்படக்கூடும். ஏதேனும் திருத்தம் வேண்டுமெனில், எனக்கு நேரடியாக தொடர்பு கொள்ளவும் அல்லது இந்த குழுவில் செய்தி இடவும்."
    },
    Hindi: {
      intro: `प्रिय समन्वयकों, निम्नलिखित समूहों ने ${STALE_GROUP_THRESHOLD_DAYS} दिनों से अधिक समय से कोई स्थिति अपडेट सबमिट नहीं किया है। कृपया यहां अपनी स्थिति सबमिट करें: ${COORDINATOR_UPDATE_FORM_LINK}`,
      listTitle: "स्थिति अपडेट की आवश्यकता वाले समूह:",
      outro: "हम फिलहाल किसी भी समूह को बंद नहीं कर रहे हैं, लेकिन जो समूह लगातार अपडेट के बिना रहते हैं उन्हें भविष्य में बंद किया जा सकता है। यदि कोई सुधार चाहिए, तो कृपया मुझसे सीधे संपर्क करें या इस समूह में संदेश करें।"
    },
    Kannada: {
      intro: `ಪ್ರಿಯ ಸಂಯೋಜಕರೇ, ಈ ಕೆಳಗಿನ ಗುಂಪುಗಳು ${STALE_GROUP_THRESHOLD_DAYS} ದಿನಗಳಿಗಿಂತ ಹೆಚ್ಚು ಕಾಲದಿಂದ ಯಾವುದೇ ಸ್ಥಿತಿ ನವೀಕರಣವನ್ನು ಸಲ್ಲಿಸಿಲ್ಲ. ದಯವಿಟ್ಟು ಇಲ್ಲಿ ನಿಮ್ಮ ಸ್ಥಿತಿಯನ್ನು ಸಲ್ಲಿಸಿ: ${COORDINATOR_UPDATE_FORM_LINK}`,
      listTitle: "ಸ್ಥಿತಿ ನವೀಕರಣ ಅಗತ್ಯವಿರುವ ಗುಂಪುಗಳು:",
      outro: "ಪ್ರಸ್ತುತ ನಾವು ಯಾವುದೇ ಗುಂಪನ್ನು ಮುಚ್ಚುತ್ತಿಲ್ಲ, ಆದರೆ ನವೀಕರಣವಿಲ್ಲದೆ ಮುಂದುವರಿಯುವ ಗುಂಪುಗಳನ್ನು ಭವಿಷ್ಯದಲ್ಲಿ ಮುಚ್ಚಬಹುದು. ಯಾವುದೇ ತಿದ್ದುಪಡಿ ಬೇಕಿದ್ದರೆ, ದಯವಿಟ್ಟು ನನಗೆ ನೇರವಾಗಿ ಸಂಪರ್ಕಿಸಿ ಅಥವಾ ಈ ಗುಂಪಿನಲ್ಲಿ ಸಂದೇಶಿಸಿ."
    },
    Telugu: {
      intro: `ప్రియమైన సమన్వయకర్తలారా, కింది గ్రూపులు ${STALE_GROUP_THRESHOLD_DAYS} రోజులకు పైగా ఎలాంటి స్థితి నవీకరణను సమర్పించలేదు. దయచేసి ఇక్కడ మీ స్థితిని సమర్పించండి: ${COORDINATOR_UPDATE_FORM_LINK}`,
      listTitle: "స్థితి నవీకరణ అవసరమైన గ్రూపులు:",
      outro: "ప్రస్తుతం మేము ఏ గ్రూప్‌ను మూసివేయడం లేదు, కానీ నవీకరణ లేకుండా కొనసాగే గ్రూపులు భవిష్యత్తులో మూసివేయబడవచ్చు. ఏదైనా సరిదిద్దాల్సి ఉంటే, దయచేసి నన్ను నేరుగా సంప్రదించండి లేదా ఈ గ్రూప్‌లో మెసేజ్ చేయండి."
    }
  };

  const t = templates[language] || templates.English;
  const lines = [t.intro, "", t.listTitle, ...groupLines, "", t.outro];

  return lines.join("\n");
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
  
  MailApp.sendEmail(applyLanguageAdminReplyTo_({
    to: email,
    subject: subject,
    htmlBody: htmlBody
  }, language));
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
  return withScriptLock_(() => suggestGroupsForLanguage_impl_(language));
}

function suggestGroupsForLanguage_impl_(language) {
  const MIN_GROUP_SIZE = 4;
  const MAX_GROUP_SIZE = 8;
  const TWO_GROUP_THRESHOLD = MAX_GROUP_SIZE + MIN_GROUP_SIZE; // e.g., 8 + 4 = 12
  const ui = SpreadsheetApp.getUi();
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

  // Batch Suggestions-column writes: mutate in memory, flush once at the end
  // instead of one getRange()/setValue()/setBackground() call per participant.
  const suggestionsCol = pIdx.Suggestions + 1;
  const suggestionsRange = pData.length
    ? pSheet.getRange(2, suggestionsCol, pData.length, 1)
    : null;
  const suggestionsValues = suggestionsRange ? suggestionsRange.getValues() : [];
  const suggestionsBackgrounds = suggestionsRange ? suggestionsRange.getBackgrounds() : [];
  let suggestionsDirty = false;
  const setSuggestionCell = (row, value, background) => {
    const i = row - 2;
    suggestionsValues[i] = [value];
    suggestionsBackgrounds[i] = [background];
    suggestionsDirty = true;
  };

  const participants = pData
    .map((r, i) => ({ row: i + 2, data: r }))
    .filter(p =>
      p.data[pIdx.Language] === language &&
      p.data[pIdx.AssignmentStatus] === "Unassigned"
    );

  const rowsWithExistingSuggestions = participants.filter(p => String(p.data[pIdx.Suggestions] || "").trim()).length;

  // Track summary counts
  const totalCandidates = participants.length;
  let suggestedExistingCount = 0; // suggested into existing active groups
  let suggestedNewCount = 0;      // suggested into newly proposed groups (NEW → ...)
  let unsuggestedCount = 0;       // leftover participants not suggested (e.g., <5 in a slot)

  // If nothing to suggest, show a quick notice
  if (totalCandidates === 0) {
    ui.alert(
      `Suggest Groups – ${language}`,
      `No unassigned participants found for ${language}.`,
      ui.ButtonSet.OK
    );
    return;
  }

  if (rowsWithExistingSuggestions > 0) {
    const response = ui.alert(
      `Overwrite Existing Suggestions – ${language}`,
      `${rowsWithExistingSuggestions} unassigned participant(s) already have suggestions.\n\n` +
      `Continuing will overwrite existing values in the Suggestions column for this language.\n\n` +
      `Do you want to continue?`,
      ui.ButtonSet.YES_NO
    );

    if (response !== ui.Button.YES) {
      return;
    }
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
      slotKey: buildCanonicalSlotKey(g[gIdx.Day], g[gIdx.Time]),
      memberCount: g[gIdx.MemberCount] || 0,
      capacity: MAX_GROUP_SIZE - (g[gIdx.MemberCount] || 0)
    }));

  // OPTIMIZATION #4: Multi-Slot Flexibility
  // Try to assign participants to existing groups using ANY of their preferred slots
  const assignedToExisting = new Set();
  
  participants.forEach(p => {
    if (assignedToExisting.has(p.row)) return;
    
    const slots = splitSlots(p.data[pIdx.PreferredSlots]).map(parseSlotDescriptor);
    
    // Try each preferred slot
    for (const slotMeta of slots) {
      if (slotMeta.key === "TBD|TBD") continue;
      
      // Find matching group with capacity
      const matchingGroup = existingGroups.find(g => 
        g.slotKey === slotMeta.key && g.capacity > 0
      );
      
      if (matchingGroup) {
        setSuggestionCell(p.row, matchingGroup.name, "#FFF2CC");

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
    const slots = splitSlots(p.data[pIdx.PreferredSlots]).map(parseSlotDescriptor);
    const uniqueKeys = {};
    slots.forEach(meta => {
      if (meta.key === "TBD|TBD") return;
      if (uniqueKeys[meta.key]) return;
      uniqueKeys[meta.key] = true;
      slotCounts[meta.key] = (slotCounts[meta.key] || 0) + 1;
    });
  });

  const slotGroups = {};
  unassignedParticipants.forEach(p => {
    const slots = splitSlots(p.data[pIdx.PreferredSlots]).map(parseSlotDescriptor);
    const uniqueByKey = [];
    const seenKeys = {};
    slots.forEach(meta => {
      if (meta.key === "TBD|TBD") return;
      if (seenKeys[meta.key]) return;
      seenKeys[meta.key] = true;
      uniqueByKey.push(meta);
    });

    if (uniqueByKey.length === 0) {
      uniqueByKey.push({ key: "TBD|TBD", label: "TBD" });
    }

    // Pick the slot with the highest overall count among this participant's options
    let bestSlotMeta = uniqueByKey[0];
    let bestCount = slotCounts[bestSlotMeta.key] || 0;
    uniqueByKey.forEach(meta => {
      const c = slotCounts[meta.key] || 0;
      if (c > bestCount) {
        bestSlotMeta = meta;
        bestCount = c;
      }
    });

    if (!slotGroups[bestSlotMeta.label]) slotGroups[bestSlotMeta.label] = [];
    slotGroups[bestSlotMeta.label].push(p);
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
              setSuggestionCell(p.row, `⚠️ NEEDS_MANUAL_REVIEW (${slot} - insufficient participants)`, "#FFE6E6");
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
        setSuggestionCell(p.row, `⚠️ NEEDS_MANUAL_REVIEW (${slot} - insufficient participants)`, "#FFE6E6");
        unsuggestedCount++;
      });
    });

    // Assign valid subgroups to new groups
    validSubgroups.forEach(subgroup => {
      const groupName = `NEW → CoC-${language}-${String(seq).padStart(3, "0")} (${slot})`;
      subgroup.forEach(p => {
        setSuggestionCell(p.row, groupName, "#FFF2CC"); // light yellow highlight for suggested cells
      });
      // Count suggestions to new groups
      suggestedNewCount += subgroup.length;
      seq++; // Increment for next group
    });
  });

  // Flush all Suggestions-column changes in one write instead of per-row calls
  if (suggestionsDirty && suggestionsRange) {
    suggestionsRange.setValues(suggestionsValues);
    suggestionsRange.setBackgrounds(suggestionsBackgrounds);
  }

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
  
  ui.alert(
    `Suggest Groups Summary – ${language}`,
    summaryMessage,
    ui.ButtonSet.OK
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
  return withScriptLock_(() => acceptGroupSuggestions_impl_(sendEmails));
}

function acceptGroupSuggestions_impl_(sendEmails = true) {
  const ss = SpreadsheetApp.getActive();
  const pSheet = ss.getSheetByName("Participants");
  const gSheet = ss.getSheetByName("Groups");

  const pData = pSheet.getDataRange().getValues();
  const gData = gSheet.getDataRange().getValues();

  const pHeaders = pData.shift();
  const gHeaders = gData.shift();

  const pIdx = indexMap(pHeaders);
  const gIdx = indexMap(gHeaders);

  // Batch the Suggestions-column background clears below into one write
  // instead of one getRange()/setBackground() call per accepted row.
  const suggestionsCol = pIdx.Suggestions + 1;
  const suggestionsBgRange = pData.length
    ? pSheet.getRange(2, suggestionsCol, pData.length, 1)
    : null;
  const suggestionsBackgrounds = suggestionsBgRange ? suggestionsBgRange.getBackgrounds() : [];
  let suggestionsBgDirty = false;

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
      suggestionsBackgrounds[i] = [null];
      suggestionsBgDirty = true;
    }
    // Always clear the AcceptSuggestion checkbox after processing
    row[pIdx.AcceptSuggestion] = false;
    pData[i] = row;

    // Track ParticipantID for Pass 2 (email sending)
    processedParticipantIDs.push(row[pIdx.ParticipantID]);
  });

  // Flush batched Suggestions-column background clears in one write
  if (suggestionsBgDirty && suggestionsBgRange) {
    suggestionsBgRange.setBackgrounds(suggestionsBackgrounds);
  }

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
          MailApp.sendEmail(applyLanguageAdminReplyTo_({ to: email, subject, body }, language));
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

function parseSlotDescriptor(slotText) {
  const raw = String(slotText || "").trim();
  if (!raw) return { day: "TBD", bucket: "TBD", key: "TBD|TBD", label: "TBD" };

  const parts = raw.split(/\s+/).filter(Boolean);
  const day = normalizeDay(parts[0] || "TBD");
  const timeText = parts.slice(1).join(" ");
  const bucket = normalizeTimeBucket(timeText || raw);
  const label = `${day} ${bucket}`.trim();

  return {
    day: day,
    bucket: bucket,
    key: `${day}|${bucket}`,
    label: label
  };
}

function buildCanonicalSlotKey(dayText, timeText) {
  const day = normalizeDay(dayText || "TBD");
  const bucket = normalizeTimeBucket(timeText || "");
  return `${day}|${bucket}`;
}

function normalizeTimeBucket(timeText) {
  const normalized = String(timeText || "").toLowerCase().trim();
  if (!normalized) return "TBD";

  if (/\bmorn(ing)?\b/.test(normalized)) return "Morning";
  if (/\bafter\s*noon\b|\bafternoon\b|\bnoon\b|\baft\b/.test(normalized)) return "Afternoon";
  if (/\beven(ing)?\b|\beve\b/.test(normalized)) return "Evening";
  if (/\bnight\b/.test(normalized)) return "Night";

  const inferredHour = inferFirstHour24_(normalized);
  if (inferredHour !== null) {
    if (inferredHour < 5) return "Night";
    if (inferredHour < 12) return "Morning";
    if (inferredHour < 17) return "Afternoon";
    if (inferredHour < 22) return "Evening";
    return "Night";
  }

  if (/\bam\b/.test(normalized)) return "Morning";
  if (/\bpm\b/.test(normalized)) return "Evening";

  return "TBD";
}

function inferFirstHour24_(text) {
  const m = String(text || "").match(/(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;

  let hour = Number(m[1]);
  const minute = Number(m[2] || 0);
  const ampm = (m[3] || "").toLowerCase();

  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  if (ampm === "am") {
    if (hour === 12) hour = 0;
  } else if (ampm === "pm") {
    if (hour < 12) hour += 12;
  } else {
    // Heuristic for missing am/pm in user-entered ranges like "3 to 4.30".
    if (hour >= 1 && hour <= 7) hour += 12;
  }

  return hour + (minute / 60);
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
  const selfServicePortalUrl = "https://www.hcessentials.org/request";
  const memberWhatsapp = memberInfo.whatsapp || labels.notProvided;
  const memberCenter = memberInfo.center || labels.notProvided;
  
  const subject = labels.memberSubject;
  const links = getMasterResourceLinks(language);
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
    <p><strong>${labels.selfServicePortal}</strong> <a href="${selfServicePortalUrl}">${selfServicePortalUrl}</a></p>
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
    
    MailApp.sendEmail(applyLanguageAdminReplyTo_(emailOptions, language));
  } catch (error) {
    throw new Error(`Email sending failed for ${email}: ${error.message}`);
  }
}

function sendCoordinatorAssignmentEmail(email, name, language, groupInfo, members) {
  if (!email || !email.trim()) {
    throw new Error(`Invalid email address for coordinator ${name}`);
  }
  
  const labels = getEmailLabels(language);
  const selfServicePortalUrl = "https://www.hcessentials.org/request";
  
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
          <li><strong>${labels.selfServicePortal}</strong> <a href="${selfServicePortalUrl}">${selfServicePortalUrl}</a></li>
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
    MailApp.sendEmail(applyLanguageAdminReplyTo_({
      to: email,
      subject: subject,
      htmlBody: htmlBody
    }, language));
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
      selfServicePortal: "Request Weekly Schedule, Documents, and Downloadable Books through our Self-service Portal:",
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
      selfServicePortal: "எங்கள் சுய சேவை தளத்தின் மூலம் வாராந்திர அட்டவணை, ஆவணங்கள் மற்றும் பதிவிறக்கக்கூடிய புத்தகங்களை கோருங்கள்:",
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
      selfServicePortal: "हमारे स्व-सेवा पोर्टल के माध्यम से साप्ताहिक कार्यक्रम, दस्तावेज़ और डाउनलोड करने योग्य पुस्तकें अनुरोध करें:",
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
      selfServicePortal: "ನಮ್ಮ ಸ್ವಯಂ-ಸೇವಾ ಪೋರ್ಟಲ್ ಮೂಲಕ ವಾರಾಂತ್ಯ ವೇಳಾಪಟ್ಟಿ, ದಾಖಲೆಗಳು ಮತ್ತು ಡೌನ್‌ಲೋಡ್ ಮಾಡಬಹುದಾದ ಪುಸ್ತಕಗಳನ್ನು ವಿನಂತಿಸಿ:",
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
      selfServicePortal: "మా స్వీయ-సేవా పోర్టల్ ద్వారా వారపు షెడ్యూల్, పత్రాలు మరియు డౌన్‌లోడ్ చేసుకోగల పుస్తకాలను అభ్యర్థించండి:",
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
      closedBodyInactive: "Dear {name},\n\nYour CoC group ({groupName}) is now closed as the group has completed all sessions. If you would like to continue your CoC journey in the future, please register at {regLink}.\n\nWith best wishes,\nCoC Admin Team",
      terminatedSubject: "CoC Group Update - {groupName}",
      terminatedBody: "Dear {name},\n\nYour CoC group ({groupName}) has been dissolved as it has not been functioning. We acknowledge your efforts.\n\nIf you think this is an error and/or you would like to continue your CoC journey, please reply to this email, or get in touch with your coordinator{coordinatorContact}. Alternatively, you can register again at {regLink} for a new group.\n\nWith best wishes,\nCoC Admin Team",
      coordinatorWhatsAppLabel: "Coordinator WhatsApp",
      discontinuedSubject: "CoC Participation Paused - {groupName}",
      discontinuedBody: "Dear {name},\n\nWe came to know that you have not been able to attend your group's ({groupName}) sessions. We understand this may be due to temporary factors that need your attention. Hence, we have paused your membership in this group for now. We appreciate your efforts to participate.\n\nIf you think the above has been done in error, please reply to this email or get in touch with your coordinator. If you would like to continue your CoC journey, you can re-register at {regLink}.\n\nWith best wishes,\nCoC Admin Team"
    },
    Tamil: {
      closedSubject: "CoC குழு மூடப்பட்டது - {groupName}",
      closedBodyActive: "அன்புள்ள {name},\n\nநீங்கள் அனைத்து அமர்வுகளையும் முடித்துவிட்டதால் உங்கள் CoC குழு ({groupName}) இப்போது மூடப்பட்டுள்ளது. உங்கள் CoC பயணத்தை வெற்றிகரமாக முடித்ததற்கு வாழ்த்துக்கள்! நீங்கள் புதிய குழுவுடன் மீண்டும் செய்ய விரும்பினால், {regLink} இல் மீண்டும் பதிவு செய்யவும்.\n\nநல்வாழ்த்துகளுடன்,\nCoC நிர்வாகக் குழு",
      closedBodyInactive: "அன்புள்ள {name},\n\nகுழு அனைத்து அமர்வுகளையும் முடித்துவிட்டதால் உங்கள் CoC குழு ({groupName}) இப்போது மூடப்பட்டுள்ளது. எதிர்காலத்தில் உங்கள் CoC பயணத்தைத் தொடர விரும்பினால், {regLink} இல் பதிவு செய்யவும்.\n\nநல்வாழ்த்துகளுடன்,\nCoC நிர்வாகக் குழு",
      terminatedSubject: "CoC குழு நிலை புதுப்பிப்பு - {groupName}",
      terminatedBody: "அன்புள்ள {name},\n\nஉங்கள் CoC குழு ({groupName}) தொடர்ந்து இயங்க முடியாத நிலை ஏற்பட்டதால், இந்த குழுவின் செயல்பாடு தற்போது நிறுத்தப்பட்டுள்ளது. உங்கள் பங்கேற்பும் முயற்சியும் மிகவும் மதிப்பிற்குரியது.\n\nஇது பிழை என்று நீங்கள் நினைத்தாலோ, அல்லது உங்கள் CoC பயணத்தைத் தொடர விரும்பினாலோ, தயவுசெய்து இந்த மின்னஞ்சலுக்கு பதிலளிக்கவும் அல்லது உங்கள் ஒருங்கிணைப்பாளரைத் தொடர்பு கொள்ளவும்{coordinatorContact}. விருப்பமிருந்தால், புதிய குழுவிற்கு {regLink} இல் மீண்டும் பதிவு செய்யலாம்.\n\nஅன்புடன்,\nCoC நிர்வாகக் குழு",
      coordinatorWhatsAppLabel: "ஒருங்கிணைப்பாளர் வாட்ஸ்அப்",
      discontinuedSubject: "CoC பங்கேற்பு தற்காலிக இடைநிறுத்தம் - {groupName}",
      discontinuedBody: "அன்புள்ள {name},\n\nஉங்கள் குழு ({groupName}) அமர்வுகளில் சில நாட்களாக கலந்துகொள்ள முடியாமல் இருப்பதை கவனித்தோம். இது தற்காலிகமான வேறு வேலைகள் அல்லது பொறுப்புகள் காரணமாக இருக்கலாம் என்று நாங்கள் புரிந்துகொள்கிறோம். அதனால், இப்போதைக்கு இந்த குழுவில் உங்கள் உறுப்பினர் நிலையை இடைநிறுத்தியுள்ளோம். இதுவரை கலந்து கொள்ள முயன்றதற்கு நன்றி.\n\nஇது தவறாக நடந்துள்ளது என்று நீங்கள் நினைத்தால், இந்த மின்னஞ்சலுக்கு பதிலளிக்கவும் அல்லது உங்கள் ஒருங்கிணைப்பாளரை தொடர்பு கொள்ளவும். CoC பயணத்தை தொடர விரும்பினால், {regLink} மூலம் எப்போது வேண்டுமானாலும் மீண்டும் பதிவு செய்யலாம்.\n\nஅன்புடன்,\nCoC நிர்வாக குழு"
    },
    Hindi: {
      closedSubject: "CoC समूह बंद - {groupName}",
      closedBodyActive: "प्रिय {name},\n\nआपका CoC समूह ({groupName}) अब बंद हो गया है क्योंकि आपने सभी सत्र पूरे कर लिए हैं। अपनी CoC यात्रा को सफलतापूर्वक पूरा करने के लिए बधाई! यदि आप एक नए समूह के साथ दोहराना चाहते हैं, तो कृपया {regLink} पर फिर से पंजीकरण करें।\n\nशुभकामनाओं के साथ,\nCoC प्रशासन टीम",
      closedBodyInactive: "प्रिय {name},\n\nआपका CoC समूह ({groupName}) अब बंद हो गया है क्योंकि समूह ने सभी सत्र पूरे कर लिए हैं। यदि आप भविष्य में अपनी CoC यात्रा जारी रखना चाहते हैं, तो कृपया {regLink} पर पंजीकरण करें।\n\nशुभकामनाओं के साथ,\nCoC प्रशासन टीम",
      terminatedSubject: "CoC समूह अपडेट - {groupName}",
      terminatedBody: "प्रिय {name},\n\nआपका CoC समूह ({groupName}) भंग कर दिया गया है क्योंकि यह कार्य नहीं कर रहा था। हम आपके प्रयासों को स्वीकार करते हैं।\n\nयदि आपको लगता है कि यह एक त्रुटि है और/या आप अपनी CoC यात्रा जारी रखना चाहते हैं, तो कृपया इस ईमेल का उत्तर दें, या अपने समन्वयक से संपर्क करें{coordinatorContact}। वैकल्पिक रूप से, आप एक नए समूह के लिए {regLink} पर फिर से पंजीकरण कर सकते हैं।\n\nशुभकामनाओं के साथ,\nCoC प्रशासन टीम",
      coordinatorWhatsAppLabel: "समन्वयक व्हाट्सऐप",
      discontinuedSubject: "CoC भागीदारी अस्थायी रूप से रोकी गई - {groupName}",
      discontinuedBody: "प्रिय {name},\n\nहमें पता चला है कि आप अपने समूह ({groupName}) के सत्रों में शामिल नहीं हो पा रहे हैं। हम समझते हैं कि यह कुछ अस्थायी कारणों से हो सकता है जिन पर आपका ध्यान आवश्यक है। इसलिए, फिलहाल इस समूह में आपकी सदस्यता को अस्थायी रूप से रोका गया है। भाग लेने के आपके प्रयासों की हम सराहना करते हैं।\n\nयदि आपको लगता है कि ऊपर किया गया यह निर्णय त्रुटिवश हुआ है, तो कृपया इस ईमेल का उत्तर दें या अपने समन्वयक से संपर्क करें। यदि आप अपनी CoC यात्रा जारी रखना चाहते हैं, तो आप {regLink} पर पुनः पंजीकरण कर सकते हैं।\n\nशुभकामनाओं के साथ,\nCoC प्रशासन टीम"
    },
    Kannada: {
      closedSubject: "CoC ಗುಂಪು ಮುಚ್ಚಲಾಗಿದೆ - {groupName}",
      closedBodyActive: "ಆತ್ಮೀಯ {name},\n\nನೀವು ಎಲ್ಲಾ ಅಧಿವೇಶನಗಳನ್ನು ಪೂರ್ಣಗೊಳಿಸಿದ್ದರಿಂದ ನಿಮ್ಮ CoC ಗುಂಪು ({groupName}) ಈಗ ಮುಚ್ಚಲಾಗಿದೆ. ನಿಮ್ಮ CoC ಪ್ರಯಾಣವನ್ನು ಯಶಸ್ವಿಯಾಗಿ ಪೂರ್ಣಗೊಳಿಸಿದ್ದಕ್ಕಾಗಿ ಅಭಿನಂದನೆಗಳು! ನೀವು ಹೊಸ ಗುಂಪಿನೊಂದಿಗೆ ಪುನರಾವರ್ತಿಸಲು ಬಯಸಿದರೆ, ದಯವಿಟ್ಟು {regLink} ನಲ್ಲಿ ಮತ್ತೆ ನೋಂದಾಯಿಸಿ.\n\nಶುಭಾಶಯಗಳೊಂದಿಗೆ,\nCoC ನಿರ್ವಹಣಾ ತಂಡ",
      closedBodyInactive: "ಆತ್ಮೀಯ {name},\n\nಗುಂಪು ಎಲ್ಲಾ ಅಧಿವೇಶನಗಳನ್ನು ಪೂರ್ಣಗೊಳಿಸಿದ್ದರಿಂದ ನಿಮ್ಮ CoC ಗುಂಪು ({groupName}) ಈಗ ಮುಚ್ಚಲಾಗಿದೆ. ಭವಿಷ್ಯದಲ್ಲಿ ನಿಮ್ಮ CoC ಪ್ರಯಾಣವನ್ನು ಮುಂದುವರಿಸಲು ಬಯಸಿದರೆ, ದಯವಿಟ್ಟು {regLink} ನಲ್ಲಿ ನೋಂದಾಯಿಸಿ.\n\nಶುಭಾಶಯಗಳೊಂದಿಗೆ,\nCoC ನಿರ್ವಹಣಾ ತಂಡ",
      terminatedSubject: "CoC ಗುಂಪು ನವೀಕರಣ - {groupName}",
      terminatedBody: "ಆತ್ಮೀಯ {name},\n\nನಿಮ್ಮ CoC ಗುಂಪು ({groupName}) ಕಾರ್ಯನಿರ್ವಹಿಸುತ್ತಿಲ್ಲದ ಕಾರಣ ವಿಸರ್ಜಿಸಲಾಗಿದೆ. ನಾವು ನಿಮ್ಮ ಪ್ರಯತ್ನಗಳನ್ನು ಅಂಗೀಕರಿಸುತ್ತೇವೆ.\n\nಇದು ದೋಷ ಎಂದು ನೀವು ಭಾವಿಸಿದರೆ ಮತ್ತು/ಅಥವಾ ನಿಮ್ಮ CoC ಪ್ರಯಾಣವನ್ನು ಮುಂದುವರಿಸಲು ಬಯಸಿದರೆ, ದಯವಿಟ್ಟು ಈ ಇಮೇಲ್‌ಗೆ ಪ್ರತ್ಯುತ್ತರಿಸಿ, ಅಥವಾ ನಿಮ್ಮ ಸಂಯೋಜಕರನ್ನು ಸಂಪರ್ಕಿಸಿ{coordinatorContact}. ಪರ್ಯಾಯವಾಗಿ, ಹೊಸ ಗುಂಪಿಗಾಗಿ ನೀವು {regLink} ನಲ್ಲಿ ಮತ್ತೆ ನೋಂದಾಯಿಸಬಹುದು.\n\nಶುಭಾಶಯಗಳೊಂದಿಗೆ,\nCoC ನಿರ್ವಹಣಾ ತಂಡ",
      coordinatorWhatsAppLabel: "ಸಂಯೋಜಕರ ವಾಟ್ಸ್ಆಪ್",
      discontinuedSubject: "CoC ಭಾಗವಹಿಸುವಿಕೆ ತಾತ್ಕಾಲಿಕ ವಿರಾಮ - {groupName}",
      discontinuedBody: "ಆತ್ಮೀಯ {name},\n\nನೀವು ನಿಮ್ಮ ಗುಂಪಿನ ({groupName}) ಅಧಿವೇಶನಗಳಿಗೆ ಹಾಜರಾಗಲು ಸಾಧ್ಯವಾಗುತ್ತಿಲ್ಲ ಎಂದು ನಮಗೆ ತಿಳಿದುಬಂದಿದೆ. ನಿಮ್ಮ ಗಮನ ಅಗತ್ಯವಿರುವ ಕೆಲವು ತಾತ್ಕಾಲಿಕ ಕಾರಣಗಳಿಂದ ಇದು ಆಗಿರಬಹುದು ಎಂದು ನಾವು ಅರ್ಥಮಾಡಿಕೊಳ್ಳುತ್ತೇವೆ. ಆದ್ದರಿಂದ, ಈಗಿನ ಮಟ್ಟಿಗೆ ಈ ಗುಂಪಿನಲ್ಲಿ ನಿಮ್ಮ ಸದಸ್ಯತ್ವವನ್ನು ತಾತ್ಕಾಲಿಕವಾಗಿ ವಿರಾಮಗೊಳಿಸಿದ್ದೇವೆ. ಭಾಗವಹಿಸಲು ನೀವು ಮಾಡಿದ ಪ್ರಯತ್ನವನ್ನು ನಾವು ಮೆಚ್ಚುತ್ತೇವೆ.\n\nಮೇಲಿನ ಕ್ರಮ ತಪ್ಪಾಗಿ ನಡೆದಿದೆ ಎಂದು ನೀವು ಭಾವಿಸಿದರೆ, ದಯವಿಟ್ಟು ಈ ಇಮೇಲ್‌ಗೆ ಉತ್ತರಿಸಿ ಅಥವಾ ನಿಮ್ಮ ಸಂಯೋಜಕರನ್ನು ಸಂಪರ್ಕಿಸಿ. ನಿಮ್ಮ CoC ಪ್ರಯಾಣವನ್ನು ಮುಂದುವರಿಸಲು ಬಯಸಿದರೆ, {regLink} ನಲ್ಲಿ ಮರು ನೋಂದಣಿ ಮಾಡಬಹುದು.\n\nಶುಭಾಶಯಗಳೊಂದಿಗೆ,\nCoC ನಿರ್ವಹಣಾ ತಂಡ"
    },
    Telugu: {
      closedSubject: "CoC గ్రూప్ మూసివేయబడింది - {groupName}",
      closedBodyActive: "ప్రియమైన {name},\n\nమీరు అన్ని సెషన్‌లను పూర్తి చేసినందున మీ CoC గ్రూప్ ({groupName}) ఇప్పుడు మూసివేయబడింది. మీ CoC ప్రయాణాన్ని విజయవంతంగా పూర్తి చేసినందుకు అభినందనలు! మీరు కొత్త గ్రూప్‌తో పునరావృతం చేయాలనుకుంటే, దయచేసి {regLink} వద్ద మళ్లీ నమోదు చేయండి.\n\nశుభాకాంక్షలతో,\nCoC నిర్వహణ బృందం",
      closedBodyInactive: "ప్రియమైన {name},\n\nగ్రూప్ అన్ని సెషన్‌లను పూర్తి చేసినందున మీ CoC గ్రూప్ ({groupName}) ఇప్పుడు మూసివేయబడింది. భవిష్యత్తులో మీ CoC ప్రయాణాన్ని కొనసాగించాలనుకుంటే, దయచేసి {regLink} వద్ద నమోదు చేయండి.\n\nశుభాకాంక్షలతో,\nCoC నిర్వహణ బృందం",
      terminatedSubject: "CoC గ్రూప్ అప్డేట్ - {groupName}",
      terminatedBody: "ప్రియమైన {name},\n\nమీ CoC గ్రూప్ ({groupName}) పనిచేయడం లేదు కాబట్టి రద్దు చేయబడింది. మేము మీ ప్రయత్నాలను గుర్తిస్తున్నాము.\n\nఇది పొరపాటు అని మీరు భావిస్తే మరియు/లేదా మీ CoC ప్రయాణాన్ని కొనసాగించాలనుకుంటే, దయచేసి ఈ ఇమెయిల్‌కు ప్రత్యుత్తరం ఇవ్వండి, లేదా మీ సమన్వయకర్తతో సంప్రదించండి{coordinatorContact}. ప్రత్యామ్నాయంగా, కొత్త గ్రూప్ కోసం మీరు {regLink} వద్ద మళ్లీ నమోదు చేసుకోవచ్చు.\n\nశుభాకాంక్షలతో,\nCoC నిర్వహణ బృందం",
      coordinatorWhatsAppLabel: "సమన్వయకర్త వాట్సాప్",
      discontinuedSubject: "CoC భాగస్వామ్యం తాత్కాలిక విరామం - {groupName}",
      discontinuedBody: "ప్రియమైన {name},\n\nమీరు మీ గ్రూప్ ({groupName}) సెషన్‌లకు హాజరు కాలేకపోతున్నారని మాకు తెలిసింది. ఇది మీ దృష్టి అవసరమైన తాత్కాలిక కారణాల వల్ల కావచ్చు అని మేము అర్థం చేసుకుంటున్నాము. అందువల్ల, ప్రస్తుతానికి ఈ గ్రూప్‌లో మీ సభ్యత్వాన్ని తాత్కాలికంగా నిలిపివేశాము. పాల్గొనడానికి మీరు చేసిన ప్రయత్నాలను మేము అభినందిస్తున్నాము.\n\nపై చర్య పొరపాటున జరిగిందని మీరు భావిస్తే, దయచేసి ఈ ఇమెయిల్‌కు ప్రత్యుత్తరం ఇవ్వండి లేదా మీ సమన్వయకర్తను సంప్రదించండి. మీ CoC ప్రయాణాన్ని కొనసాగించాలనుకుంటే, మీరు {regLink} వద్ద మళ్లీ నమోదు చేసుకోవచ్చు.\n\nశుభాకాంక్షలతో,\nCoC నిర్వహణ బృందం"
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
  MailApp.sendEmail(applyLanguageAdminReplyTo_(emailOptions, language));
}
