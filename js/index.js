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
    
    const missingFields = [];
    
    // Check Language first (required before anything else)
    if (!lang) {
      missingFields.push("Language");
      errorEl.textContent = "Missing required fields: " + missingFields.join(", ");
      errorEl.style.display = "block";
      return; // ⛔ STOP submission
    }
    
    // Check other required fields
    if (!fdCheck.get("Email")) missingFields.push("Email");
    if (!fdCheck.get("Name")) missingFields.push("Your Name");
    if (!fdCheck.get("WhatsApp")) missingFields.push("WhatsApp Number");
    if (!fdCheck.get("Center")) missingFields.push("Your Heartfulness Center");
    if (selectedTimes.length === 0) missingFields.push("Preferred days & times");
    if (!fdCheck.get("Coordinator")) missingFields.push("Willing to be a coordinator");
    if (!document.getElementById("disclaimerConsent").checked) missingFields.push("Disclaimer Consent");
    
    // Check EnglishAbility only if non-English language is selected
    if (lang !== "English" && !knowsEnglish) missingFields.push("English Ability");

    if (missingFields.length > 0) {
      errorEl.textContent = "Missing required fields: " + missingFields.join(", ");
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
    if (lang) {
      applyLanguage(lang);
      toggleEnglishQuestion(lang);
    }
  });
});
