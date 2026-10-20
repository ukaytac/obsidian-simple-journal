// @vitest-environment jsdom
/**
 * Scale benchmark for `JournalService`. Not part of `npm test`: run with
 * `npm run bench`. Each case runs once — the "before" numbers for the startup
 * storm are measured in seconds, and repeating them buys nothing.
 *
 * The storm is modelled the way Obsidian produces it: the plugin loads, then
 * the vault fires `create` for every file, then the layout becomes ready.
 */
import { bench, describe } from "vitest";
import type { App, TFile } from "obsidian";
import { createFakeApp } from "../obsidian-mock";
import { EntryRepository } from "../../src/journal/entryRepository";
import { JournalService } from "../../src/services/journalService";

const ENTRIES = 50_000;
const OTHER_NOTES = 50_000;
const RENAMES = 10_000;
const ONCE = { iterations: 1, time: 0, warmupIterations: 0, warmupTime: 0 };

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Unique, convention-following entry paths spread over a few years. */
function entryPath(i: number): string {
  const d = new Date(2020, 0, 1, 0, 0, 0);
  d.setMinutes(d.getMinutes() + i * 37);
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const name = `${y}-${m}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(i % 60)}`;
  return `Journal/${y}/${m}/${name}.md`;
}

function seed() {
  const fake = createFakeApp();
  const entries: TFile[] = [];
  const others: TFile[] = [];
  for (let i = 0; i < ENTRIES; i++) entries.push(fake.vault.addFile(entryPath(i), "") as unknown as TFile);
  for (let i = 0; i < OTHER_NOTES; i++) {
    others.push(fake.vault.addFile(`Notes/${Math.floor(i / 1000)}/note-${i}.md`, "") as unknown as TFile);
  }
  const repository = new EntryRepository(fake as unknown as App, () => "Journal");
  return { fake, entries, others, repository };
}

/** Runs the debounced flush now, the way `journalViewHarness.ts` reaches past `private`. */
function flushNow(service: JournalService): void {
  (service as unknown as { flush(): void }).flush();
}

describe("JournalService at 50k entries + 50k other notes", () => {
  // Every case below seeds its own vault inside the timed body, so this is
  // the floor each of them stands on. Subtract it to read a case's own cost;
  // it does not depend on JournalService, so one measurement serves both the
  // before and the after run.
  bench("reference: seeding the vault only", () => {
    seed();
  }, ONCE);

  bench(
    "startup: load, create storm for every file, layout ready, flush",
    () => {
      const { fake, entries, others, repository } = seed();
      fake.workspace.layoutReady = false;
      const service = new JournalService(fake as unknown as App, repository);
      service.load();
      for (const file of entries) fake.vault.trigger("create", file);
      for (const file of others) fake.vault.trigger("create", file);
      fake.workspace.fireLayoutReady();
      flushNow(service);
      service.unload();
    },
    ONCE,
  );

  bench(
    `bulk rename: ${RENAMES} entries moved to the journal root, then flush`,
    async () => {
      const { fake, entries, repository } = seed();
      const service = new JournalService(fake as unknown as App, repository);
      service.load();
      for (const file of entries.slice(0, RENAMES)) {
        await fake.fileManager.renameFile(file as never, `Journal/${file.basename}.md`);
      }
      flushNow(service);
      service.unload();
    },
    ONCE,
  );

  bench(
    "typing elsewhere: 100 modify+changed pairs on a non-journal note, flushed each time",
    () => {
      const { fake, others, repository } = seed();
      const service = new JournalService(fake as unknown as App, repository);
      service.load();
      const note = others[0];
      for (let i = 0; i < 100; i++) {
        fake.vault.trigger("modify", note);
        fake.metadataCache.trigger("changed", note);
        flushNow(service);
      }
      service.unload();
    },
    ONCE,
  );
});
