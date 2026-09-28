// ==UserScript==
// @name         Uma Usage Overview
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Show Current CM Uma usage statistics on Hakuraku
// @author       TMK1k + Clanker
// @match        https://hakuraku.moe/umalogs*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=hakuraku.moe
// @grant        none
// @run-at       document-idle
// ==/UserScript==

function getSelectedSnapshot() {
  const selector = document.querySelector(".sim-dataset-select");
  const selectedSnapshot = selector?.selectedOptions?.[0]?.value?.trim();

  return selectedSnapshot || null;
}

async function showUsageOverview() {
  let snapshot = getSelectedSnapshot();

  if (!snapshot) {
    const manifestResponse = await fetch("/api/simdata/manifest");

    if (!manifestResponse.ok) {
      throw new Error(
        `Manifest request failed: ${manifestResponse.status} ${manifestResponse.statusText}`,
      );
    }

    const manifestData = await manifestResponse.json();

    /*
     * Search the complete manifest for snapshot IDs.
     * This works even if the manifest structure changes or IDs are nested.
     */
    const manifestText = JSON.stringify(manifestData);

    const snapshots = [
      ...new Set(manifestText.match(/cm\d+-\d{4}-\d{2}-\d{2}/gi) ?? []),
    ];

    /*
     * ISO-formatted dates sort correctly as text.
     */
    snapshots.sort((a, b) => b.localeCompare(a));
    snapshot = snapshots[0];

    if (!snapshot) {
      console.log("Manifest response:", manifestData);

      throw new Error("Could not find a snapshot ID in the manifest.");
    }
  }

  console.log(`Using snapshot: ${snapshot}`);

  const [summaryResponse, teamsResponse] = await Promise.all([
    fetch(`/api/simdata/snapshots/${snapshot}/summary`),
    fetch(`/api/simdata/snapshots/${snapshot}/teams?limit=1`),
  ]);

  if (!summaryResponse.ok) {
    throw new Error(
      `Summary request failed: ${summaryResponse.status} ${summaryResponse.statusText}`,
    );
  }

  if (!teamsResponse.ok) {
    throw new Error(
      `Teams request failed: ${teamsResponse.status} ${teamsResponse.statusText}`,
    );
  }

  const [summaryData, teamsData] = await Promise.all([
    summaryResponse.json(),
    teamsResponse.json(),
  ]);

  const totalTeams = Number(teamsData.totalTeams);

  if (!Number.isFinite(totalTeams) || totalTeams <= 0) {
    console.log("Teams response:", teamsData);

    throw new Error(
      `Could not find a valid totalTeams value. Received: ${teamsData.totalTeams}`,
    );
  }

  const pairCollections = [];

  function findPairs(value) {
    if (!value || typeof value !== "object") return;

    if (Object.prototype.hasOwnProperty.call(value, "pairs")) {
      pairCollections.push(value.pairs);
    }

    Object.values(value).forEach(findPairs);
  }

  findPairs(summaryData);

  const pairs = pairCollections.flatMap((collection) =>
    Array.isArray(collection) ? collection : Object.values(collection ?? {}),
  );

  const totals = new Map();

  for (const pair of pairs) {
    if (!pair || Number(pair.style) === 6) continue;

    const runners = Number(pair.runners);

    if (!Number.isFinite(runners)) continue;

    const name = pair.name ?? "Unknown";
    const outfit = pair.outfit ?? "";
    const key = JSON.stringify([name, outfit]);

    const existing = totals.get(key) ?? {
      card: pair.card ?? "",
      chara: pair.chara ?? "",
      name,
      outfit,
      runners: 0,
    };

    existing.runners += runners;
    totals.set(key, existing);
  }

  const result = [...totals.values()]
    .map((entry) => ({
      card: entry.card,
      chara: entry.chara,
      name: entry.name,
      outfit: entry.outfit,
      runners: entry.runners,
      share: entry.runners / totalTeams,
    }))
    .sort((a, b) => b.runners - a.runners)
    .map((entry, index) => ({
      card: entry.card,
      chara: entry.chara,
      rank: index + 1,
      name: entry.name,
      outfit: entry.outfit,
      runners: entry.runners,
      percentage: `${(entry.share * 100).toFixed(2)}%`,
      share: entry.share,
    }));

  const content = document.getElementById("uma-usage-overview-content");

  if (!content) {
    throw new Error("Could not find the Usage Overview tab content.");
  }

  content.replaceChildren();
  Object.assign(content.style, {
    fontSize: "0.95rem",
  });

  /*
   * Header
   */
  const header = document.createElement("div");

  Object.assign(header.style, {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "1rem",
    padding: "1rem 0",
    boxSizing: "border-box",
    borderBottom: "1px solid var(--bs-border-color, #dee2e6)",
  });

  const titleArea = document.createElement("div");

  const title = document.createElement("h1");
  title.textContent = "Uma usage overview";

  Object.assign(title.style, {
    margin: "0 0 0.25rem",
    fontSize: "1.5rem",
    fontWeight: "500",
  });

  const subtitle = document.createElement("div");
  subtitle.textContent =
    `${result.length.toLocaleString()} entries | ` +
    `${totalTeams.toLocaleString()} total teams | ` +
    `Debuffers excluded`;

  Object.assign(subtitle.style, {
    color: "var(--bs-secondary-color, #6c757d)",
    fontSize: "0.875rem",
  });

  titleArea.append(title, subtitle);
  header.append(titleArea);

  /*
   * Table
   */
  const tableContainer = document.createElement("div");

  Object.assign(tableContainer.style, {
    overflow: "auto",
    padding: "1rem 0",
    boxSizing: "border-box",
    scrollbarGutter: "stable",
  });

  const table = document.createElement("table");

  Object.assign(table.style, {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: "0.9rem",
  });

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");

  const columns = [
    ["Rank", "center"],
    ["Image", "center"],
    ["Name", "left"],
    ["Outfit", "left"],
    ["Runners", "right"],
    ["Percentage", "right"],
  ];

  for (const [label, alignment] of columns) {
    const th = document.createElement("th");
    th.textContent = label;

    Object.assign(th.style, {
      position: "sticky",
      top: "0",
      zIndex: "1",
      padding: "0.65rem 0.75rem",
      textAlign: alignment,
      borderBottom: "2px solid var(--bs-border-color, #dee2e6)",
      background: "var(--bs-tertiary-bg, #f8f9fa)",
      color: "inherit",
      whiteSpace: "nowrap",
    });

    headerRow.appendChild(th);
  }

  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  for (const row of result) {
    const tr = document.createElement("tr");

    tr.addEventListener("mouseenter", () => {
      tr.style.background = "var(--bs-tertiary-bg, #f8f9fa)";
    });

    tr.addEventListener("mouseleave", () => {
      tr.style.background = "";
    });

    const values = [
      [row.outfit, "left"],
      [row.runners.toLocaleString(), "right"],
      [row.percentage, "right"],
    ];

    const rankCell = document.createElement("td");
    rankCell.textContent = row.rank;
    Object.assign(rankCell.style, {
      width: "5rem",
      padding: "0.5rem 0.75rem",
      textAlign: "center",
      borderBottom: "1px solid var(--bs-border-color, #dee2e6)",
    });
    tr.appendChild(rankCell);

    const imageCell = document.createElement("td");
    Object.assign(imageCell.style, {
      width: "5rem",
      padding: "0.5rem 0.75rem",
      textAlign: "center",
      borderBottom: "1px solid var(--bs-border-color, #dee2e6)",
    });

    if (row.chara && row.card) {
      const image = document.createElement("img");
      image.src =
        `https://hakuraku.moe/assets/character_thumbs/` +
        `chara_stand_${row.chara}_${row.card}.webp`;
      image.alt = `${row.name} thumbnail`;
      image.loading = "lazy";
      Object.assign(image.style, {
        display: "block",
        width: "2.5rem",
        height: "2.5rem",
        objectFit: "contain",
        margin: "0 auto",
      });
      imageCell.appendChild(image);
    }

    tr.appendChild(imageCell);

    const textValues = [[row.name, "left"], ...values];

    for (const [value, alignment] of textValues) {
      const td = document.createElement("td");
      td.textContent = value;

      Object.assign(td.style, {
        padding: "0.65rem 0.75rem",
        textAlign: alignment,
        borderBottom: "1px solid var(--bs-border-color, #dee2e6)",
      });

      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  tableContainer.appendChild(table);
  content.append(header, tableContainer);

  /*
   * Start at the top of the output.
   */
  tableContainer.scrollTop = 0;

  console.log(`Total teams: ${totalTeams.toLocaleString()}`);
  console.log(`Displayed entries: ${result.length}`);
  console.log("The table is displayed over the webpage.");

  return {
    totalTeams,
    result,
  };
}

function isUsageOverviewSelected() {
  return (
    new URLSearchParams(window.location.search).get("tab") === "usage-overview"
  );
}

async function activateUsageOverview(button, content, navigation, tabContent) {
  navigation.querySelectorAll('[role="tab"]').forEach((tab) => {
    tab.classList.remove("active");
    tab.setAttribute("aria-selected", "false");
  });
  tabContent.querySelectorAll('[role="tabpanel"]').forEach((panel) => {
    panel.classList.remove("show", "active");
  });

  button.classList.add("active");
  button.setAttribute("aria-selected", "true");
  content.classList.add("show", "active");

  try {
    await showUsageOverview();
  } catch (error) {
    console.error("Could not load usage overview:", error);
    content.textContent = "Could not load usage overview.";
  }
}

function bindDatasetSelector() {
  const selector = document.querySelector(".sim-dataset-select");

  if (!selector || selector.dataset.umaUsageBound === "true") {
    return;
  }

  selector.dataset.umaUsageBound = "true";
  selector.addEventListener("change", () => {
    if (!isUsageOverviewSelected()) {
      return;
    }

    const button = document.getElementById("uma-usage-overview-button");
    const content = document.getElementById("uma-usage-overview-content");
    const navigation = document.querySelector(".sim-section-nav.nav.nav-tabs");
    const tabContent = document.querySelector(".tab-content");

    if (button && content && navigation && tabContent) {
      void activateUsageOverview(button, content, navigation, tabContent);
    }
  });
}

function addUsageOverviewButton() {
  const navigation = document.querySelector(".sim-section-nav.nav.nav-tabs");
  const tabContent = document.querySelector(".tab-content");

  bindDatasetSelector();

  if (!navigation || !tabContent) {
    return false;
  }

  if (navigation.querySelector("#uma-usage-overview-button")) {
    return true;
  }

  const button = document.createElement("a");
  button.id = "uma-usage-overview-button";
  button.className = "nav-link";
  const usageUrl = new URL(window.location.href);
  usageUrl.searchParams.set("tab", "usage-overview");
  button.href = usageUrl.href;
  button.textContent = "Usage Overview";
  button.setAttribute("role", "tab");
  button.setAttribute("aria-controls", "uma-usage-overview-content");
  button.setAttribute("aria-selected", "false");

  const content = document.createElement("div");
  content.id = "uma-usage-overview-content";
  content.className = "tab-pane fade";
  content.setAttribute("role", "tabpanel");
  content.setAttribute("aria-labelledby", button.id);

  tabContent.appendChild(content);
  navigation.appendChild(button);

  button.addEventListener("click", (event) => {
    event.preventDefault();

    if (isUsageOverviewSelected()) {
      return;
    }

    window.history.pushState({}, "", button.href);
    void activateUsageOverview(button, content, navigation, tabContent);
  });

  navigation.addEventListener("click", (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab && tab !== button) {
      button.classList.remove("active");
      button.setAttribute("aria-selected", "false");
      content.classList.remove("show", "active");
    }
  });

  window.addEventListener("popstate", () => {
    if (isUsageOverviewSelected()) {
      void activateUsageOverview(button, content, navigation, tabContent);
      return;
    }

    button.classList.remove("active");
    button.setAttribute("aria-selected", "false");
    content.classList.remove("show", "active");
  });

  if (isUsageOverviewSelected()) {
    void activateUsageOverview(button, content, navigation, tabContent);
  }

  return true;
}

addUsageOverviewButton();

const observer = new MutationObserver(() => {
  addUsageOverviewButton();
});

observer.observe(document.body, { childList: true, subtree: true });
