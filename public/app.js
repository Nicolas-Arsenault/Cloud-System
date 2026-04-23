const form = document.querySelector("#search-form");
const submitButton = document.querySelector("#submit-button");
const statusBadge = document.querySelector("#status-badge");
const statusMessage = document.querySelector("#status-message");
const requestId = document.querySelector("#request-id");
const resultsMeta = document.querySelector("#results-meta");
const errorMessage = document.querySelector("#error-message");
const resultsList = document.querySelector("#results-list");

const POLL_INTERVAL_MS = 1500;
let activeSearchToken = 0;

renderEmptyState("Use the form to search retailer listings.");

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const retailer = String(formData.get("retailer") || "").trim();
  const zip = String(formData.get("zip") || "").trim();
  const query = String(formData.get("query") || "").trim();

  if (!retailer || !zip || !query) {
    setStatus("error", "Fill in retailer, zip code, and search query.");
    showError("All fields are required.");
    renderEmptyState("Submit a complete search to view listings.");
    return;
  }

  activeSearchToken += 1;
  const searchToken = activeSearchToken;

  hideError();
  setBusy(true);
  setStatus("loading", `Searching ${retailer} for "${query}" in ${zip}...`);
  requestId.hidden = true;
  requestId.textContent = "";
  resultsMeta.textContent = "Fetching listings...";

  try {
    await runSearch({ retailer, zip, query }, searchToken);
  } finally {
    if (searchToken === activeSearchToken) {
      setBusy(false);
    }
  }
});

async function runSearch(params, searchToken) {
  while (searchToken === activeSearchToken) {
    const response = await fetchListings(params);
    const payload = await parseJson(response);

    if (searchToken !== activeSearchToken) {
      return;
    }

    if (response.status === 200) {
      hideError();
      setStatus(
        "ready",
        `Showing ${payload.listings.length} result${payload.listings.length === 1 ? "" : "s"} for "${params.query}".`
      );
      requestId.hidden = true;
      requestId.textContent = "";
      resultsMeta.textContent = `${capitalize(params.retailer)} in ${params.zip}`;
      renderResults(payload.listings);
      return;
    }

    if (response.status === 202) {
      hideError();
      setStatus("loading", "Search queued. Waiting for worker to populate the cache...");
      requestId.hidden = false;
      requestId.textContent = `Request ID: ${payload.requestId}`;
      resultsMeta.textContent = "Queued. Polling for results...";
      renderEmptyState("The request is queued. Results will appear here automatically.");
      await delay(POLL_INTERVAL_MS);
      continue;
    }

    const apiError = payload.error || `Request failed with status ${response.status}.`;
    setStatus("error", apiError);
    showError(apiError);
    renderEmptyState("No listings to show.");
    return;
  }
}

async function fetchListings(params) {
  const searchParams = new URLSearchParams(params);
  return fetch(`/listings?${searchParams.toString()}`, {
    headers: {
      Accept: "application/json"
    }
  });
}

async function parseJson(response) {
  try {
    return await response.json();
  } catch (error) {
    return {};
  }
}

function renderResults(listings) {
  resultsList.innerHTML = "";

  if (!Array.isArray(listings) || listings.length === 0) {
    renderEmptyState("The API returned no listings for this search.");
    return;
  }

  for (const listing of listings) {
    const item = document.createElement("li");
    item.className = "result-card";

    const title = document.createElement("h3");
    title.textContent = listing.title || "Untitled listing";

    const meta = document.createElement("p");
    meta.className = "listing-meta";
    meta.textContent = buildMetaText(listing);

    item.append(title, meta);

    if (listing.url) {
      const link = document.createElement("a");
      link.className = "result-link";
      link.href = listing.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "Open listing";
      item.append(link);
    }

    resultsList.append(item);
  }
}

function buildMetaText(listing) {
  const parts = [];

  if (listing.price) {
    parts.push(`Price: ${listing.price}`);
  }

  if (listing.retailer) {
    parts.push(`Retailer: ${capitalize(String(listing.retailer))}`);
  }

  return parts.join(" | ") || "No extra details available.";
}

function renderEmptyState(message) {
  resultsList.innerHTML = "";
  const item = document.createElement("li");
  item.className = "empty-state";
  item.textContent = message;
  resultsList.append(item);
}

function setStatus(mode, message) {
  statusBadge.className = `status-badge status-${mode}`;
  statusBadge.textContent = mode === "ready"
    ? "Ready"
    : mode === "loading"
      ? "Loading"
      : mode === "error"
        ? "Error"
        : "Idle";
  statusMessage.textContent = message;
}

function showError(message) {
  errorMessage.hidden = false;
  errorMessage.textContent = message;
}

function hideError() {
  errorMessage.hidden = true;
  errorMessage.textContent = "";
}

function setBusy(isBusy) {
  submitButton.disabled = isBusy;
  submitButton.textContent = isBusy ? "Searching..." : "Search";
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
