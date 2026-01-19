function checkEmailQuota() {
  const emailQuotaRemaining = MailApp.getRemainingDailyQuota();
  Logger.log(`Remaining email quota: ${emailQuotaRemaining}`);
}

function setupAllCoCSheets() {
  const ss = SpreadsheetApp.getActive();

  const sheetsConfig = [
    {
      name: "Participants",
      headers: [
        "ParticipantID",
        "Name",
        "Email",
        "WhatsApp",
        "Language",
        "Center",
        "PreferredSlots",
        "CoordinatorWilling",
        "AssignedGroup",
        "AssignmentStatus",
        "IsGroupCoordinator",
        "AcceptSuggestion",
        "Suggestions",
        "Notes",
        "IsActive"
      ]
    },
    {
      name: "Groups",
      headers: [
        "GroupID",
        "GroupCreationDate",
        "GroupName",
        "Language",
        "Day",
        "Time",
        "CoordinatorEmail",
        "CoordinatorName",
        "MemberCount",
        "Status",
        "Sequence",
        "WeeksCompleted",
        "Notes",
        "LastUpdated"
      ]
    },
    {
      name: "AdminDashboard",
      headers: [
        "DashboardSection",
        "Metric",
        "English",
        "Tamil",
        "Hindi",
        "Kannada",
        "Telugu"
      ]
    }
  ];

  sheetsConfig.forEach(cfg => {
    let sheet = ss.getSheetByName(cfg.name);
    if (!sheet) {
      sheet = ss.insertSheet(cfg.name);
    }

    // Write headers only if first row is empty
    const firstRow = sheet.getRange(1, 1, 1, cfg.headers.length).getValues()[0];
    const isEmpty = firstRow.every(c => c === "");

    if (isEmpty) {
      sheet.getRange(1, 1, 1, cfg.headers.length).setValues([cfg.headers]);
      sheet.getRange(1, 1, 1, cfg.headers.length)
        .setFontWeight("bold")
        .setBackground("#f1f3f4");
      sheet.setFrozenRows(1);
    }
  });

  SpreadsheetApp.getUi().alert("All CoC admin sheets are set up successfully.");
}
