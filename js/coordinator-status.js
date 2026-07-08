document.addEventListener("DOMContentLoaded", () => {
  const WEBAPP_URL = "https://script.google.com/macros/s/AKfycbxPw3PzC2RVFoo1cmxknCiwZeUr_wtECxDrI-2wzfTP3LK0rttnt2EzAuPuJU-M6WniCw/exec";
  const today = new Date().toISOString().slice(0, 10);
  const SITE_KEY = "6Ld11zssAAAAAMa8hkYJHz1AWvXuUh_WIfad0zbT";

  const langSelect = document.getElementById("langSelect");
  const language = document.getElementById("language");
  const groupSelect = document.getElementById("groupSelect");
  const statusSel = document.getElementById("status");
  const weeksSel = document.getElementById("weeksCompleted");
  const weeksRow = document.getElementById("weeksRow");
  const daySel = document.getElementById("day");
  const timeInput = document.getElementById("time");
  const membersList = document.getElementById("membersList");
  const membersBox = document.getElementById("membersBox");
  const notesEl = document.getElementById("notes");
  const statusMsg = document.getElementById("statusMsg");
  const submitBtn = document.getElementById("submitBtn");
  const honey = document.getElementById("honey");
  const discontinueConfirm = document.getElementById("discontinueConfirm");
  const discontinueConfirmBody = document.getElementById("discontinueConfirmBody");
  const discontinueGoBack = document.getElementById("discontinueGoBack");
  const discontinueConfirmBtn = document.getElementById("discontinueConfirmBtn");

  let groupsCache = [];

  function setStatus(message, ok = false) {
    statusMsg.textContent = message || "";
    statusMsg.classList.toggle("success", !!ok);
  }

  function currentDict() {
    return (typeof translations !== "undefined" && translations[language.value]) || null;
  }

  function setSubmitting(state) {
    submitBtn.disabled = !!state;
    submitBtn.textContent = state ? "Submitting..." : "Submit Update";
  }

  function fillWeeksOptions() {
    weeksSel.innerHTML = "";
    for (let i = 0; i <= 25; i++) {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = i;
      weeksSel.appendChild(opt);
    }
  }

  function toggleWeeks() {
    if (statusSel.value === "Active" || statusSel.value === "Completed") {
      weeksRow.classList.remove("hidden");
    } else {
      weeksRow.classList.add("hidden");
      weeksSel.value = "0";
    }
  }

  function buildMembersUI(members) {
    membersList.innerHTML = "";
    const rows = members || [];

    if (rows.length === 0) {
      const dict = currentDict();
      membersList.textContent = (dict && dict.noMembers) || "No members found for this group.";
      return;
    }

    const dict = currentDict();
    const keepText = (dict && dict.keepLabel) || "Keep";
    const discontinueText = (dict && dict.discontinueLabel) || "Discontinue";

    rows.forEach(m => {
      const isKeep = !!m.isActive;
      const row = document.createElement("div");
      row.className = "member-item";
      row.dataset.participantId = m.participantID;
      row.dataset.state = isKeep ? "keep" : "discontinue";

      const name = document.createElement("span");
      name.className = "member-name";
      name.textContent = m.center ? `${m.name} (${m.center})` : m.name;

      const seg = document.createElement("div");
      seg.className = "segmented";

      const keepBtn = document.createElement("button");
      keepBtn.type = "button";
      keepBtn.className = "seg-keep" + (isKeep ? " is-on" : "");
      keepBtn.textContent = keepText;

      const discontinueBtn = document.createElement("button");
      discontinueBtn.type = "button";
      discontinueBtn.className = "seg-discontinue" + (isKeep ? "" : " is-on");
      discontinueBtn.textContent = discontinueText;

      seg.appendChild(keepBtn);
      seg.appendChild(discontinueBtn);
      row.appendChild(name);
      row.appendChild(seg);
      membersList.appendChild(row);
    });
  }

  membersList.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-keep, .seg-discontinue");
    if (!btn) return;
    const row = btn.closest(".member-item");
    const toKeep = btn.classList.contains("seg-keep");
    row.dataset.state = toKeep ? "keep" : "discontinue";
    row.querySelectorAll(".segmented button").forEach(b => b.classList.remove("is-on"));
    btn.classList.add("is-on");
  });

  function setDayValue(day) {
    const val = (day || "").trim();
    if (!val) {
      daySel.value = "";
      return;
    }
    const match = Array.from(daySel.options).some(o => o.value === val);
    if (!match) {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = val;
      daySel.appendChild(opt);
    }
    daySel.value = val;
  }

  function getSelectedGroupMeta() {
    const opt = groupSelect.options[groupSelect.selectedIndex];
    if (!opt || !opt.value) return null;
    return {
      groupID: opt.value,
      groupName: opt.dataset.groupName,
      coordinatorName: opt.dataset.coordinatorName || "",
      status: opt.dataset.status || "",
      weeksCompleted: opt.dataset.weeks || "0",
      day: opt.dataset.day || "",
      time: opt.dataset.time || ""
    };
  }

  function callApi(action, payload = {}) {
    return grecaptcha.execute(SITE_KEY, { action: "submit" }).then(token => {
      const fd = new FormData();
      fd.append("action", action);
      Object.keys(payload).forEach(k => fd.append(k, payload[k]));
      fd.append("recaptcha", token);
      fd.append("honey", honey.value || "");
      return fetch(WEBAPP_URL, { method: "POST", body: fd }).then(r => r.json());
    });
  }

  function loadGroups() {
    setStatus("Loading groups...");
    const dict = currentDict();
    callApi("queryCoordinatorGroups", { Language: language.value })
      .then(res => {
        if (res.result !== "success") throw new Error(res.error || "Failed to load groups");
        groupsCache = res.groups || [];
        groupSelect.innerHTML = "";
        if (groupsCache.length === 0) {
          const opt = document.createElement("option");
          opt.value = "";
          opt.textContent = (dict && dict.noGroups) || "No groups for this language";
          groupSelect.appendChild(opt);
          buildMembersUI([]);
          setStatus("No groups found", false);
          return;
        }
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = (dict && dict.selectCoordinator) || "Select coordinator / group";
        groupSelect.appendChild(placeholder);
        groupsCache.forEach(g => {
          const opt = document.createElement("option");
          opt.value = g.groupID;
          opt.textContent = `${g.coordinatorName || "Coordinator"} (${g.groupName})`;
          opt.dataset.groupName = g.groupName;
          opt.dataset.coordinatorName = g.coordinatorName || "";
          opt.dataset.status = g.status || "Active";
          opt.dataset.weeks = g.weeksCompleted || 0;
          opt.dataset.day = g.day || "";
          opt.dataset.time = g.time || "";
          groupSelect.appendChild(opt);
        });
        setStatus("");
      })
      .catch(err => setStatus(err.message || "Failed to load groups"));
  }

  function loadMembersForSelection() {
    const meta = getSelectedGroupMeta();
    if (!meta) {
      buildMembersUI([]);
      return;
    }

    statusSel.value = meta.status || "Active";
    weeksSel.value = String(meta.weeksCompleted || 0);
    setDayValue(meta.day || "");
    timeInput.value = meta.time || "";
    toggleWeeks();

    setStatus("Loading members...");
    callApi("getGroupMembers", { GroupName: meta.groupName })
      .then(res => {
        if (res.result !== "success") throw new Error(res.error || "Failed to load members");
        buildMembersUI(res.members || []);
        setStatus("");
      })
      .catch(err => setStatus(err.message || "Failed to load members"));
  }

  function collectMembersUpdate() {
    const membersUpdate = {};
    membersList.querySelectorAll(".member-item").forEach(row => {
      membersUpdate[row.dataset.participantId] = row.dataset.state !== "discontinue";
    });
    return membersUpdate;
  }

  function namesToDiscontinue() {
    return Array.from(membersList.querySelectorAll('.member-item[data-state="discontinue"]'))
      .map(row => row.querySelector(".member-name").textContent);
  }

  function performSubmit(meta, membersUpdate) {
    const payload = {
      groupID: meta.groupID,
      groupName: meta.groupName,
      coordinatorName: meta.coordinatorName,
      status: statusSel.value,
      weeksCompleted: (statusSel.value === "Active" || statusSel.value === "Completed") ? weeksSel.value : "0",
      day: daySel.value,
      time: timeInput.value.trim(),
      notes: notesEl.value.trim(),
      today,
      members: JSON.stringify(membersUpdate)
    };

    setSubmitting(true);

    callApi("updateGroupStatus", payload)
      .then(res => {
        if (res.result !== "success") throw new Error(res.error || "Update failed");
        setStatus("Update saved successfully. You can close this page.", true);
      })
      .catch(err => setStatus(err.message || "Update failed"))
      .finally(() => {
        setSubmitting(false);
      });
  }

  function handleSubmit() {
    setStatus("");
    const meta = getSelectedGroupMeta();
    if (!meta) {
      setStatus("Please select a group");
      return;
    }

    const names = namesToDiscontinue();
    if (names.length === 0) {
      performSubmit(meta, collectMembersUpdate());
      return;
    }

    const dict = currentDict();
    const template = (dict && dict.discontinueConfirmBody) ||
      "You're about to discontinue {names}. They'll be removed from this group and notified by email. This can't be undone.";
    discontinueConfirmBody.textContent = template.replace("{names}", names.join(", "));
    discontinueConfirm.classList.remove("hidden");
    submitBtn.classList.add("hidden");
  }

  discontinueGoBack.addEventListener("click", () => {
    discontinueConfirm.classList.add("hidden");
    submitBtn.classList.remove("hidden");
  });

  discontinueConfirmBtn.addEventListener("click", () => {
    discontinueConfirm.classList.add("hidden");
    submitBtn.classList.remove("hidden");
    const meta = getSelectedGroupMeta();
    if (!meta) {
      setStatus("Please select a group");
      return;
    }
    performSubmit(meta, collectMembersUpdate());
  });

  // Init
  fillWeeksOptions();
  toggleWeeks();
  applyLanguage(language.value);

  langSelect.addEventListener("change", function () {
    const lang = this.value;
    language.value = lang;
    if (lang) {
      applyLanguage(lang);
      loadGroups();
    }
  });
  groupSelect.addEventListener("change", loadMembersForSelection);
  statusSel.addEventListener("change", toggleWeeks);
  submitBtn.addEventListener("click", handleSubmit);

  document.getElementById("todayLine").textContent = `Today: ${today}`;
  loadGroups();
});
