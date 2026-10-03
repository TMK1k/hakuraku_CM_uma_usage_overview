// ==UserScript==
// @name         Uma Usage Overview
// @namespace    http://tampermonkey.net/
// @version      1.3.0
// @description  Show Current CM Uma usage statistics on Hakuraku
// @author       TMK1k + Clanker
// @match        https://hakuraku.moe/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=hakuraku.moe
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/** Returns the snapshot selected by Hakuraku's dataset dropdown. */
function getSelectedSnapshot() {
  const selector = document.querySelector(".sim-dataset-select");
  const selectedSnapshot = selector?.selectedOptions?.[0]?.value?.trim();

  return selectedSnapshot || null;
}

/** Extracts the CM number used to choose the correct API format. */
function getSnapshotCmNumber(snapshot) {
  const match = /^cm(\d+)-/i.exec(snapshot);

  return match ? Number(match[1]) : null;
}

/** Gets the selected snapshot, or discovers the newest snapshot from the manifest. */
async function getSnapshot() {
  const selectedSnapshot = getSelectedSnapshot();

  if (selectedSnapshot) return selectedSnapshot;

  const manifestResponse = await fetch("/api/simdata/manifest");

  if (!manifestResponse.ok) {
    throw new Error(
      `Manifest request failed: ${manifestResponse.status} ${manifestResponse.statusText}`,
    );
  }

  const manifestData = await manifestResponse.json();
  const manifestText = JSON.stringify(manifestData);
  const snapshots = [
    ...new Set(manifestText.match(/cm\d+-\d{4}-\d{2}-\d{2}/gi) ?? []),
  ];

  snapshots.sort((a, b) => b.localeCompare(a));

  if (!snapshots[0]) {
    console.log("Manifest response:", manifestData);
    throw new Error("Could not find a snapshot ID in the manifest.");
  }

  return snapshots[0];
}

/** Recursively finds every `pairs` collection in a legacy summary response. */
function getPairCollections(value, collections = []) {
  if (!value || typeof value !== "object") return collections;

  if (Object.prototype.hasOwnProperty.call(value, "pairs")) {
    collections.push(value.pairs);
  }

  Object.values(value).forEach((child) =>
    getPairCollections(child, collections),
  );

  return collections;
}

/** Converts array or numeric-keyed pair collections into one flat array. */
function getPairsFromCollections(collections) {
  return collections.flatMap((collection) =>
    Array.isArray(collection) ? collection : Object.values(collection ?? {}),
  );
}

/** Builds a card-ID lookup used to label new API usage entries. */
function getCardMetadata(summaryData) {
  const cards = summaryData?.cards;

  if (!cards || typeof cards !== "object") return new Map();

  return new Map(Object.entries(cards));
}

/**
 * Removes debuffers, combines style entries, and calculates player shares.
 * Legacy pairs use `runners`; CM20+ pairs use `players`.
 */
function aggregateUsage(
  pairs,
  totalPlayers,
  isNewApi,
  cardMetadata = new Map(),
) {
  const totals = new Map();

  for (const pair of pairs) {
    if (!pair || Number(pair.style) === 6) continue;

    const players = Number(isNewApi ? pair.players : pair.runners);

    if (!Number.isFinite(players)) continue;

    const card = pair.card ?? "";
    const metadata = cardMetadata.get(String(card)) ?? {};
    const chara = pair.chara ?? metadata.chara ?? "";
    const name =
      pair.name ?? metadata.name ?? (chara ? `Chara ${chara}` : "Unknown");
    const outfit =
      pair.outfit ?? metadata.outfit ?? (card ? `Card ${card}` : "");
    const key = isNewApi
      ? JSON.stringify([chara, card])
      : JSON.stringify([name, outfit]);
    const existing = totals.get(key) ?? {
      card,
      chara,
      name,
      outfit,
      players: 0,
    };

    existing.players += players;
    totals.set(key, existing);
  }

  return [...totals.values()]
    .map((entry) => ({
      ...entry,
      share: entry.players / totalPlayers,
    }))
    .sort((a, b) => b.players - a.players)
    .map((entry, index) => ({
      ...entry,
      rank: index + 1,
      percentage: `${(entry.share * 100).toFixed(2)}%`,
    }));
}

/** Loads and normalizes either the legacy or CM20+ usage response. */
async function fetchUsageData(snapshot) {
  const cmNumber = getSnapshotCmNumber(snapshot);

  if (cmNumber === null) {
    throw new Error(`Could not determine CM number from snapshot: ${snapshot}`);
  }

  if (cmNumber >= 20) {
    const [usageResponse, summaryResponse] = await Promise.all([
      fetch(`/api/simdata/snapshots/${snapshot}/uma-usage`),
      fetch(`/api/simdata/snapshots/${snapshot}/summary`),
    ]);

    if (!usageResponse.ok) {
      throw new Error(
        `Uma usage request failed: ${usageResponse.status} ${usageResponse.statusText}`,
      );
    }

    if (!summaryResponse.ok) {
      throw new Error(
        `Summary request failed: ${summaryResponse.status} ${summaryResponse.statusText}`,
      );
    }

    const [data, summaryData] = await Promise.all([
      usageResponse.json(),
      summaryResponse.json(),
    ]);
    const totalPlayers = Number(data.totalPlayers);

    if (!Number.isFinite(totalPlayers) || totalPlayers <= 0) {
      console.log("Uma usage response:", data);
      throw new Error(
        `Could not find a valid totalPlayers value. Received: ${data.totalPlayers}`,
      );
    }

    return {
      totalPlayers,
      result: aggregateUsage(
        getPairsFromCollections([data.pairs ?? []]),
        totalPlayers,
        true,
        getCardMetadata(summaryData),
      ),
    };
  }

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
  const totalPlayers = Number(teamsData.totalTeams);

  if (!Number.isFinite(totalPlayers) || totalPlayers <= 0) {
    console.log("Teams response:", teamsData);
    throw new Error(
      `Could not find a valid totalTeams value. Received: ${teamsData.totalTeams}`,
    );
  }

  return {
    totalPlayers,
    result: aggregateUsage(
      getPairsFromCollections(getPairCollections(summaryData)),
      totalPlayers,
      false,
    ),
  };
}

// Prevent repeated tab or dataset events from issuing duplicate requests.
const usageDataCache = new Map();

/** Returns cached or in-flight usage data for a snapshot. */
function loadUsageData(snapshot) {
  if (!usageDataCache.has(snapshot)) {
    const request = fetchUsageData(snapshot);
    usageDataCache.set(snapshot, request);
    request.catch(() => usageDataCache.delete(snapshot));
  }

  return usageDataCache.get(snapshot);
}

/** Rebuilds the custom tab contents from the normalized usage result. */
async function showUsageOverview() {
  const snapshot = await getSnapshot();

  console.log(`Using snapshot: ${snapshot}`);

  const { totalPlayers, result } = await loadUsageData(snapshot);

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
    `${totalPlayers.toLocaleString()} total players | ` +
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
    ["Players", "right"],
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
      [row.players.toLocaleString(), "right"],
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

  console.log(`Total players: ${totalPlayers.toLocaleString()}`);
  console.log(`Displayed entries: ${result.length}`);
  console.log("The table is displayed over the webpage.");

  return {
    totalPlayers,
    result,
  };
}

/** Checks whether the custom usage tab is selected in the current URL. */
function isUsageOverviewSelected() {
  const params = new URLSearchParams(window.location.search);

  return (
    params.get("uma-tab") === "usage-overview" ||
    params.get("tab") === "usage-overview"
  );
}

/** Clicks a native tab so Hakuraku's own tab state stays synchronized. */
function selectNativeTab(navigation, customButton) {
  const nativeTab = [...navigation.querySelectorAll('[role="tab"]')].find(
    (tab) => tab !== customButton,
  );

  if (nativeTab instanceof HTMLElement) {
    nativeTab.click();
  }
}

/** Writes the selected native or custom tab into the query string. */
function updateTabUrl(tabKey, historyMethod = "pushState") {
  const tabUrl = new URL(window.location.href);

  if (tabKey === "usage-overview") {
    tabUrl.searchParams.set("uma-tab", "usage-overview");
    tabUrl.searchParams.delete("tab");
  } else if (tabKey === "introduction") {
    tabUrl.searchParams.delete("uma-tab");
    tabUrl.searchParams.delete("tab");
  } else {
    tabUrl.searchParams.delete("uma-tab");
    tabUrl.searchParams.set("tab", tabKey);
  }

  tabUrl.hash = "";

  if (tabUrl.href !== window.location.href) {
    window.history[historyMethod]({}, "", tabUrl.href);
  }
}

/** Defers URL changes until after the current tab event has completed. */
function scheduleTabUrlUpdate(tabKey, historyMethod = "pushState") {
  window.setTimeout(() => {
    updateTabUrl(tabKey, historyMethod);
  }, 0);
}

/** Finds a native tab by its React-Bootstrap event key or generated ID. */
function getNativeTab(navigation, tabKey) {
  return [...navigation.querySelectorAll('[role="tab"]')].find(
    (tab) =>
      tab.getAttribute("data-rr-ui-event-key") === tabKey ||
      tab.id === `simdata-tabs-tab-${tabKey}`,
  );
}

/** Finds the native panel associated with a tab key. */
function getNativeTabPanel(tabContent, tabKey) {
  return tabContent.querySelector(
    `#simdata-tabs-tabpane-${CSS.escape(tabKey)}`,
  );
}

/** Restores Hakuraku's introduction tab after leaving the custom tab. */
function restoreNativeIntroduction(navigation, tabContent) {
  tabContent.querySelectorAll('[role="tabpanel"]').forEach((panel) => {
    panel.classList.remove("show", "active");
  });

  navigation.querySelectorAll('[role="tab"]').forEach((tab) => {
    tab.classList.remove("active");
    tab.setAttribute("aria-selected", "false");
    tab.setAttribute("tabindex", "-1");
  });

  const introductionTab = getNativeTab(navigation, "introduction");
  const introductionPanel = getNativeTabPanel(tabContent, "introduction");

  introductionTab?.classList.add("active");
  introductionTab?.setAttribute("aria-selected", "true");
  introductionTab?.setAttribute("tabindex", "0");
  introductionPanel?.classList.add("show", "active");
}

/** Removes a transient native active class that can override custom tab state. */
function removeIntroductionTabActiveClass(navigation) {
  const introductionTab = navigation.querySelector(
    "#simdata-tabs-tab-introduction",
  );

  introductionTab?.classList.remove("active");
}

/** Reapplies the custom tab state briefly while native tab updates settle. */
function scheduleIntroductionTabReset(navigation) {
  const endTime = performance.now() + 100;

  function removeOnFrame(timestamp) {
    removeIntroductionTabActiveClass(navigation);

    if (timestamp < endTime) {
      window.requestAnimationFrame(removeOnFrame);
    }
  }

  window.requestAnimationFrame(removeOnFrame);
}

/** Activates the custom tab and loads its current snapshot data. */
async function activateUsageOverview(button, content, navigation, tabContent) {
  tabContent.querySelectorAll('[role="tabpanel"]').forEach((panel) => {
    panel.classList.remove("show", "active");
  });

  button.classList.add("active");
  button.setAttribute("aria-selected", "true");
  button.setAttribute("tabindex", "0");
  content.classList.add("show", "active");
  removeIntroductionTabActiveClass(navigation);
  scheduleIntroductionTabReset(navigation);

  try {
    await showUsageOverview();
  } catch (error) {
    console.error("Could not load usage overview:", error);
    content.textContent = "Could not load usage overview.";
  }
}

/** Deactivates the custom tab and optionally restores the introduction tab. */
function deactivateUsageOverview(
  button,
  content,
  navigation,
  tabContent,
  restoreIntroduction = false,
) {
  button.classList.remove("active");
  button.setAttribute("aria-selected", "false");
  button.setAttribute("tabindex", "-1");
  content.classList.remove("show", "active");

  if (restoreIntroduction) {
    restoreNativeIntroduction(navigation, tabContent);
  }
}

/** Reloads the usage tab when Hakuraku replaces the selected dataset. */
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

/** Installs the custom tab once the native navigation has rendered. */
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
  button.className = "sim-section-link nav-link";
  button.href = "#";
  button.setAttribute("tabindex", "-1");
  button.textContent = "Usage Overview";
  button.setAttribute("role", "tab");
  button.setAttribute("data-rr-ui-event-key", "usage-overview");
  button.setAttribute("aria-controls", "uma-usage-overview-content");
  button.setAttribute("aria-selected", "false");

  const navItem = document.createElement("div");
  navItem.className = "nav-item";
  navItem.appendChild(button);

  const content = document.createElement("div");
  content.id = "uma-usage-overview-content";
  content.className = "tab-pane fade";
  content.setAttribute("role", "tabpanel");
  content.setAttribute("aria-labelledby", button.id);

  tabContent.appendChild(content);
  navigation.appendChild(navItem);

  button.addEventListener("click", (event) => {
    event.preventDefault();

    if (isUsageOverviewSelected()) {
      return;
    }

    selectNativeTab(navigation, button);
    scheduleTabUrlUpdate("usage-overview");
    void activateUsageOverview(button, content, navigation, tabContent);
  });

  navigation.addEventListener("click", (event) => {
    const tab =
      event.target instanceof Element
        ? event.target.closest('[role="tab"]')
        : null;

    if (tab && tab !== button) {
      const tabKey = tab.getAttribute("data-rr-ui-event-key");

      if (tabKey) {
        scheduleTabUrlUpdate(tabKey);
      }

      deactivateUsageOverview(
        button,
        content,
        navigation,
        tabContent,
        tabKey === "introduction",
      );
    }
  });

  window.addEventListener("popstate", () => {
    if (isUsageOverviewSelected()) {
      selectNativeTab(navigation, button);
      scheduleTabUrlUpdate("usage-overview", "replaceState");
      void activateUsageOverview(button, content, navigation, tabContent);
      return;
    }

    const tabKey =
      new URLSearchParams(window.location.search).get("tab") ?? "introduction";

    deactivateUsageOverview(
      button,
      content,
      navigation,
      tabContent,
      tabKey === "introduction",
    );
  });

  if (isUsageOverviewSelected()) {
    selectNativeTab(navigation, button);
    scheduleTabUrlUpdate("usage-overview", "replaceState");
    void activateUsageOverview(button, content, navigation, tabContent);
  }

  return true;
}

addUsageOverviewButton();

const observer = new MutationObserver(() => {
  addUsageOverviewButton();
});

observer.observe(document.body, { childList: true, subtree: true });
