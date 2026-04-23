const logsStatus = document.querySelector("#logs-status");
const logsUpdated = document.querySelector("#logs-updated");
const logsCount = document.querySelector("#logs-count");
const logsMeta = document.querySelector("#logs-meta");
const logsError = document.querySelector("#logs-error");
const logsEmpty = document.querySelector("#logs-empty");
const logsTableWrap = document.querySelector("#logs-table-wrap");
const logsTableBody = document.querySelector("#logs-table-body");

const LOGS_POLL_INTERVAL_MS = 5000;

void refreshLogs();
setInterval(() => {
  void refreshLogs();
}, LOGS_POLL_INTERVAL_MS);

async function refreshLogs() {
  try {
    const response = await fetch("/api/logs", {
      headers: {
        Accept: "application/json"
      }
    });
    const payload = await parseJson(response);

    if (!response.ok) {
      throw new Error(payload.error || `Request failed with status ${response.status}.`);
    }

    const logs = Array.isArray(payload.logs) ? payload.logs : [];

    hideError();
    setStatus("Live");
    logsUpdated.textContent = formatUpdatedTime(new Date());
    logsCount.textContent = String(logs.length);
    logsMeta.textContent = logs.length === 0
      ? "No logs returned from PostgreSQL."
      : `Showing ${logs.length} most recent row${logs.length === 1 ? "" : "s"}.`;

    if (logs.length === 0) {
      logsTableWrap.hidden = true;
      logsEmpty.hidden = false;
      logsTableBody.innerHTML = "";
      return;
    }

    logsEmpty.hidden = true;
    logsTableWrap.hidden = false;
    renderLogs(logs);
  } catch (error) {
    setStatus("Error");
    logsMeta.textContent = "Could not load database logs.";
    showError(error.message);
  }
}

function renderLogs(logs) {
  logsTableBody.innerHTML = "";

  for (const log of logs) {
    const row = document.createElement("tr");

    row.append(
      buildCell(formatTimestamp(log.timestamp)),
      buildLevelCell(String(log.level || "")),
      buildCell(log.worker_id || "api"),
      buildMessageCell(log.msg || "")
    );

    logsTableBody.append(row);
  }
}

function buildCell(value) {
  const cell = document.createElement("td");
  cell.textContent = value;
  return cell;
}

function buildLevelCell(level) {
  const cell = document.createElement("td");
  const badge = document.createElement("span");
  const normalizedLevel = level.toLowerCase() || "debug";

  badge.className = `log-level log-level-${normalizedLevel}`;
  badge.textContent = normalizedLevel;
  cell.append(badge);
  return cell;
}

function buildMessageCell(message) {
  const cell = document.createElement("td");
  cell.className = "logs-message";
  cell.textContent = message;
  return cell;
}

async function parseJson(response) {
  try {
    return await response.json();
  } catch (error) {
    return {};
  }
}

function formatTimestamp(value) {
  if (!value) {
    return "Unknown";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium"
  }).format(parsed);
}

function formatUpdatedTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    timeStyle: "medium"
  }).format(value);
}

function setStatus(value) {
  logsStatus.textContent = value;
}

function showError(message) {
  logsError.hidden = false;
  logsError.textContent = message;
}

function hideError() {
  logsError.hidden = true;
  logsError.textContent = "";
}
