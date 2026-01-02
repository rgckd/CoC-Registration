document.addEventListener("DOMContentLoaded", () => {

  const WEBAPP_URL = "https://script.google.com/macros/s/AKfycbxPw3PzC2RVFoo1cmxknCiwZeUr_wtECxDrI-2wzfTP3LK0rttnt2EzAuPuJU-M6WniCw/exec";
  const SITE_KEY = "6Ld11zssAAAAAMa8hkYJHz1AWvXuUh_WIfad0zbT";

  const form = document.getElementById("regForm");
  const btn = document.getElementById("submitBtn");
  const errorEl = document.getElementById("formError");

  function setSubmitting(state) {
    if (state) {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>Submitting... Please wait';
      submitBtn.disabled = true;
    } else {
      btn.disabled = false;
      btn.textContent = "Submit Registration";
      form.querySelectorAll("input, select").forEach(el => el.disabled = false);
    }
  }

  btn.addEventListener("click", () => {
    errorEl.style.display = "none";

    const fdCheck = new FormData(form);
    const lang = fdCheck.get("Language");
    const knowsEnglish = fdCheck.get("EnglishAbility");
    const selectedTimes = fdCheck.getAll("Times");

    // Validation
    if (
      !fdCheck.get("Email") ||
      !fdCheck.get("Name") ||
      !fdCheck.get("WhatsApp") ||
      !fdCheck.get("Center") ||
      !fdCheck.get("Coordinator") ||
      selectedTimes.length === 0 ||
      (lang !== "English" && !knowsEnglish)
    ) {
      errorEl.textContent = "Missing required fields";
      errorEl.style.display = "block";
      return; // ⛔ STOP submission
    }


    grecaptcha.ready(() => {
      grecaptcha.execute(SITE_KEY, { action: "submit" }).then(token => {

        const fd = new FormData(form);
        fd.append("recaptcha", token);
    
        setSubmitting(true);

        fetch(WEBAPP_URL, { method: "POST", body: fd })
          .then(r => r.json())
          .then(res => {
            if (res.result === "success") {
              window.location.href = "success.html";
            } else {
              setSubmitting(false);
              errorEl.textContent = res.error || "Submission failed.";
              errorEl.style.display = "block";
            }
          })
          .catch(() => {
            setSubmitting(false);
            errorEl.textContent = "Network error. Please try again.";
            errorEl.style.display = "block";
          });

      });
    });
  });

  // Language switching
  function toggleEnglishQuestion(lang) {
    const box = document.getElementById("englishQuestion");
    const select = box.querySelector("select");

    if (lang === "English") {
      box.classList.add("hidden");
      select.removeAttribute("required");
      select.value = "";
    } else {
      box.classList.remove("hidden");
      select.setAttribute("required","required");
    }
  }

  document.getElementById("langSelect").addEventListener("change", function () {
    const lang = this.value;
    document.getElementById("Language").value = lang;
    applyLanguage(lang);
    toggleEnglishQuestion(lang);
  });

  applyLanguage("English");
  toggleEnglishQuestion("English");
});
