// Adds an item through the API (with the CSRF header), then reloads the list.
const form = document.getElementById("add-item");
const input = document.getElementById("item-name");
const status = document.getElementById("add-status");
const button = form.querySelector("button");

function say(text, tone) {
  status.textContent = text;
  if (tone) status.dataset.tone = tone;
  else delete status.dataset.tone;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = input.value.trim();
  if (!name) {
    say("Give the item a name.", "error");
    input.focus();
    return;
  }
  button.setAttribute("aria-busy", "true");
  button.disabled = true;
  say("Adding…");
  try {
    const res = await fetch("/api/items", {
      method: "POST",
      headers: { "content-type": "application/json", "x-app": "1" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(error);
    }
    location.reload();
  } catch (e) {
    say(`Couldn't add it: ${e.message}`, "error");
    button.removeAttribute("aria-busy");
    button.disabled = false;
    input.focus();
  }
});
