import type { FactoryProject, RouteChoice, RouteOption } from "./types";

/** The `active` value that leaves every option on for the LP to pick or mix. */
export const SOLVER_PICKS = "solver";
export const MIN_ROUTE_OPTIONS = 2;
export const MAX_ROUTE_OPTIONS = 6;

/** The option a choice runs, or undefined when the solver picks. */
export function activeOption(choice: RouteChoice): RouteOption | undefined {
  return choice.active === SOLVER_PICKS
    ? undefined
    : choice.options.find((option) => option.id === choice.active);
}

/**
 * The project as the solver should see it: every card and drawer of a
 * non-active option is switched off. The stored `enabled` flags are never
 * touched (a new project object is returned only when something changes).
 * A drawer has no off switch, so an inactive drawer and its wires leave the
 * copy handed to the solver. A card a player disabled by hand stays disabled
 * even in the active option.
 */
export function applyRouteChoices(project: FactoryProject): FactoryProject {
  const choices = project.routeChoices;
  if (!choices || choices.length === 0) return project;
  const offNodes = new Set<string>();
  const offStorages = new Set<string>();
  for (const choice of choices) {
    if (choice.active === SOLVER_PICKS) continue;
    const hasActive = choice.options.some((option) => option.id === choice.active);
    if (!hasActive) continue;
    for (const option of choice.options) {
      if (option.id === choice.active) continue;
      option.nodeIds.forEach((id) => offNodes.add(id));
      option.storageIds.forEach((id) => offStorages.add(id));
    }
  }
  // A card shared by the active option of one choice and a dormant one of
  // another stays on only if some active option claims it.
  for (const choice of choices) {
    const active = choice.options.find((option) => option.id === choice.active);
    active?.nodeIds.forEach((id) => offNodes.delete(id));
    active?.storageIds.forEach((id) => offStorages.delete(id));
  }
  if (offNodes.size === 0 && offStorages.size === 0) return project;
  const dropNodes = project.nodes.some((n) => n.enabled && offNodes.has(n.id));
  return {
    ...project,
    nodes: dropNodes
      ? project.nodes.map((node) => (offNodes.has(node.id) && node.enabled ? { ...node, enabled: false } : node))
      : project.nodes,
    storages: project.storages?.filter((storage) => !offStorages.has(storage.id)),
    edges:
      offStorages.size === 0
        ? project.edges
        : project.edges.filter((edge) => !offStorages.has(edge.source) && !offStorages.has(edge.target)),
  };
}

/** Card and drawer ids a non-active option switches off, with their badge text. */
export function inactiveRouteMarks(choices: RouteChoice[] | undefined): Map<string, string> {
  const marks = new Map<string, string>();
  for (const choice of choices ?? []) {
    if (choice.active === SOLVER_PICKS) continue;
    if (!choice.options.some((option) => option.id === choice.active)) continue;
    for (const option of choice.options) {
      if (option.id === choice.active) continue;
      const tag = optionTag(option);
      [...option.nodeIds, ...option.storageIds].forEach((id) => marks.set(id, tag));
    }
  }
  return marks;
}

/** "A: Electrolyzer" becomes "Alt A (off)". */
export function optionTag(option: RouteOption): string {
  const lead = option.label.split(":")[0]?.trim() || option.label;
  return `Alt ${lead} (off)`;
}

/**
 * Drops ids that no longer exist from every option, then any choice left with
 * fewer than two options. An active id that vanished falls back to the solver.
 * Returns the same object when nothing changes.
 */
export function pruneRouteChoices(project: FactoryProject): FactoryProject {
  const choices = project.routeChoices;
  if (!choices) return project;
  const nodeIds = new Set(project.nodes.map((n) => n.id));
  const storageIds = new Set((project.storages ?? []).map((s) => s.id));
  let changed = false;
  const next: RouteChoice[] = [];
  for (const choice of choices) {
    let options = choice.options.map((option) => {
      const nodes = option.nodeIds.filter((id) => nodeIds.has(id));
      const storages = option.storageIds.filter((id) => storageIds.has(id));
      if (nodes.length === option.nodeIds.length && storages.length === option.storageIds.length) return option;
      changed = true;
      return { ...option, nodeIds: nodes, storageIds: storages };
    });
    // An option that lost every card is gone, not an empty alternative.
    // (Keep empty ones that were empty from the start: "do nothing" is a route.)
    const survivors = options.filter(
      (option, i) =>
        option.nodeIds.length + option.storageIds.length > 0 ||
        choice.options[i].nodeIds.length + choice.options[i].storageIds.length === 0,
    );
    if (survivors.length !== options.length) {
      changed = true;
      options = survivors;
    }
    if (options.length < MIN_ROUTE_OPTIONS) {
      changed = true;
      continue;
    }
    const active =
      choice.active === SOLVER_PICKS || options.some((o) => o.id === choice.active) ? choice.active : SOLVER_PICKS;
    if (active !== choice.active) changed = true;
    next.push(options === choice.options && active === choice.active ? choice : { ...choice, options, active });
  }
  if (!changed) return project;
  return { ...project, routeChoices: next.length > 0 ? next : undefined };
}

const OPTION_LETTERS = "ABCDEF";

export interface RouteSelection {
  nodeIds: string[];
  storageIds: string[];
}

/** Splits board ids (cards, drawers, anything else) into the two kinds an option holds. */
export function splitBoardIds(project: FactoryProject, ids: readonly string[]): RouteSelection {
  const nodes = new Set(project.nodes.map((n) => n.id));
  const storages = new Set((project.storages ?? []).map((s) => s.id));
  return {
    nodeIds: ids.filter((id) => nodes.has(id)),
    storageIds: ids.filter((id) => storages.has(id)),
  };
}

/** "A: Electrolyzer": the letter plus the first card's machine. */
function describeOption(project: FactoryProject, index: number, selection: RouteSelection): string {
  const letter = OPTION_LETTERS[index] ?? String(index + 1);
  const first = project.nodes.find((n) => n.id === selection.nodeIds[0]);
  const recipe = first ? project.recipes.find((r) => r.id === first.recipeId) : undefined;
  const what = recipe?.machineType ?? (selection.nodeIds.length + selection.storageIds.length === 0 ? "Nothing" : "Drawers");
  return `${letter}: ${what}`;
}

function replaceChoice(project: FactoryProject, choiceId: string, next: RouteChoice | undefined): FactoryProject {
  const choices = (project.routeChoices ?? []).flatMap((c) => (c.id !== choiceId ? [c] : next ? [next] : []));
  return { ...project, routeChoices: choices.length > 0 ? choices : undefined };
}

/** Cards claimed by one option leave the sibling options of the same choice. */
function claim(choice: RouteChoice, optionId: string, selection: RouteSelection): RouteChoice {
  const nodes = new Set(selection.nodeIds);
  const storages = new Set(selection.storageIds);
  return {
    ...choice,
    options: choice.options.map((option) =>
      option.id === optionId
        ? {
            ...option,
            nodeIds: [...new Set([...option.nodeIds, ...selection.nodeIds])],
            storageIds: [...new Set([...option.storageIds, ...selection.storageIds])],
          }
        : {
            ...option,
            nodeIds: option.nodeIds.filter((id) => !nodes.has(id)),
            storageIds: option.storageIds.filter((id) => !storages.has(id)),
          },
    ),
  };
}

/** A new comparison: the selection is option A, option B starts empty to be filled from the board. */
export function createRouteChoice(
  project: FactoryProject,
  name: string,
  selection: RouteSelection,
  ids: { choice: string; a: string; b: string },
  createdAt = new Date().toISOString(),
): FactoryProject {
  const choice: RouteChoice = {
    id: ids.choice,
    name: name.trim() || "Route choice",
    active: ids.a,
    createdAt,
    options: [
      { id: ids.a, label: describeOption(project, 0, selection), nodeIds: selection.nodeIds, storageIds: selection.storageIds, origin: "manual" },
      { id: ids.b, label: "B: Nothing", nodeIds: [], storageIds: [], origin: "manual" },
    ],
  };
  return { ...project, routeChoices: [...(project.routeChoices ?? []), choice] };
}

/**
 * The selection becomes an option of an existing choice: it fills the first
 * empty option, otherwise a new one (up to six). Returns the project
 * unchanged when the choice is missing or full.
 */
export function addRouteOption(
  project: FactoryProject,
  choiceId: string,
  selection: RouteSelection,
  optionId: string,
): FactoryProject {
  const choice = project.routeChoices?.find((c) => c.id === choiceId);
  if (!choice || selection.nodeIds.length + selection.storageIds.length === 0) return project;
  const empty = choice.options.findIndex((o) => o.nodeIds.length + o.storageIds.length === 0);
  if (empty >= 0) {
    const target = choice.options[empty];
    const relabelled = {
      ...choice,
      options: choice.options.map((o, i) =>
        i === empty ? { ...o, label: describeOption(project, i, selection) } : o,
      ),
    };
    return replaceChoice(project, choiceId, claim(relabelled, target.id, selection));
  }
  if (choice.options.length >= MAX_ROUTE_OPTIONS) return project;
  const index = choice.options.length;
  const added: RouteChoice = {
    ...choice,
    options: [
      ...choice.options,
      { id: optionId, label: describeOption(project, index, selection), nodeIds: [], storageIds: [], origin: "manual" },
    ],
  };
  return replaceChoice(project, choiceId, claim(added, optionId, selection));
}

export function setRouteActive(project: FactoryProject, choiceId: string, active: string): FactoryProject {
  const choice = project.routeChoices?.find((c) => c.id === choiceId);
  if (!choice || choice.active === active) return project;
  if (active !== SOLVER_PICKS && !choice.options.some((o) => o.id === active)) return project;
  return replaceChoice(project, choiceId, { ...choice, active });
}

/** Drops one option (its cards stay on the board); a choice left with one option goes. */
export function removeRouteOption(project: FactoryProject, choiceId: string, optionId: string): FactoryProject {
  const choice = project.routeChoices?.find((c) => c.id === choiceId);
  if (!choice || !choice.options.some((o) => o.id === optionId)) return project;
  const options = choice.options.filter((o) => o.id !== optionId);
  if (options.length < MIN_ROUTE_OPTIONS) return replaceChoice(project, choiceId, undefined);
  const active = choice.active === optionId ? SOLVER_PICKS : choice.active;
  return replaceChoice(project, choiceId, { ...choice, options, active });
}

export function deleteRouteChoice(project: FactoryProject, choiceId: string): FactoryProject {
  return replaceChoice(project, choiceId, undefined);
}

/** The cards and drawers every option except `keepId` owns, minus anything the kept one also claims. */
export function otherOptionCards(choice: RouteChoice, keepId: string): RouteSelection {
  const keep = choice.options.find((o) => o.id === keepId);
  const keepNodes = new Set(keep?.nodeIds);
  const keepStorages = new Set(keep?.storageIds);
  const nodeIds = new Set<string>();
  const storageIds = new Set<string>();
  for (const option of choice.options) {
    if (option.id === keepId) continue;
    option.nodeIds.filter((id) => !keepNodes.has(id)).forEach((id) => nodeIds.add(id));
    option.storageIds.filter((id) => !keepStorages.has(id)).forEach((id) => storageIds.add(id));
  }
  return { nodeIds: [...nodeIds], storageIds: [...storageIds] };
}
