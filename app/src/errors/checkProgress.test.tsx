// `:check HOST` live (ticket 110, #193): serve's check job pushes `job.progress` as each step starts
// (API 21), and the panel shows the step under way as it runs, through the App with the fake Backend.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { FAKE_PASSWORD, fakeBackend, makeHosts, type FakeBackend, type FakeScenario } from "../backend/fake";
import { BackendCallError, CHECK_STEPS, type HostCheck, type JobProgress } from "../backend/types";
import { memoryPlatform } from "../platform/memory";
import { StubTerminal } from "../terminal/StubTerminal";

const hosts = makeHosts(12);
const reviewed = hosts.hosts.filter((h) => h.reviewed);
const host = reviewed[0]!.name;
const other = reviewed[1]!.name;
const LEADER = "{Control>} {/Control}";

async function ready(scenario: Partial<FakeScenario> = {}) {
  const user = userEvent.setup();
  const backend = fakeBackend({ hosts, apiVersion: 21, heldChecks: [host, other], ...scenario });
  render(<App backend={backend} terminalView={StubTerminal} platform={memoryPlatform()} />);
  await screen.findByText(/12 hosts/i);
  await user.type(await screen.findByLabelText(/master password/i), `${FAKE_PASSWORD}{Enter}`);
  await screen.findByRole("main", { name: /workspace/i });
  return { user, backend };
}

async function check(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.keyboard(`${LEADER}:`);
  await user.keyboard(`check ${name}{Enter}`);
  return screen.findByRole("region", { name: `Check ${name}` });
}

/** serve's `job.progress` for a check of `name` as step `at` starts. */
function progress(backend: FakeBackend, name: string, at: string | null, extra: Partial<JobProgress> = {}) {
  const done = at === null ? 0 : CHECK_STEPS.indexOf(at as (typeof CHECK_STEPS)[number]);
  act(() => backend.jobProgress({ kind: "check", job: "check-1", action: "check", state: "running", done, total: 8, at, host: name, ...extra }));
}

const statuses = (panel: HTMLElement) => within(panel).getAllByRole("listitem").map((li) => li.getAttribute("data-status"));
const running = (panel: HTMLElement) => panel.querySelector('[data-status="running"]')?.getAttribute("data-step") ?? null;

function stoppedAt(name: string, at: number): HostCheck {
  return {
    host: name,
    ok: false,
    steps: CHECK_STEPS.map((step, i) =>
      i < at ? { step, status: "ok" as const, message: `${step} fine` } : { step, status: "skipped" as const, message: "the check was stopped" },
    ),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe(":check HOST, live", () => {
  it("lists every step from the start, and marks the one under way as each starts", async () => {
    const { user, backend } = await ready();
    const panel = await check(user, host);
    // Every row is there before the first step, so nothing moves as steps come in.
    expect(within(panel).getAllByRole("listitem").map((li) => li.getAttribute("data-step"))).toEqual([...CHECK_STEPS]);
    expect(statuses(panel)).toEqual(Array(8).fill("pending"));
    progress(backend, host, null);
    expect(running(panel)).toBeNull();
    progress(backend, host, "inventory");
    expect(running(panel)).toBe("inventory");
    progress(backend, host, "tcp");
    expect(statuses(panel)).toEqual(["done", "done", "done", "done", "done", "running", "pending", "pending"]);
    const tcp = panel.querySelector('[data-step="tcp"]')!;
    expect(tcp).toHaveTextContent(/under way/);
  });

  it("says how long a step has taken once it takes a while, so a step that hangs doesn't look frozen", async () => {
    const { user, backend } = await ready();
    const panel = await check(user, host);
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    progress(backend, host, "tcp");
    const tcp = panel.querySelector('[data-step="tcp"]')!;
    act(() => vi.advanceTimersByTime(2000));
    expect(tcp).not.toHaveTextContent(/\d s/);
    act(() => vi.advanceTimersByTime(10_000));
    expect(tcp).toHaveTextContent("12 s");
    // The next step starts its own count.
    progress(backend, host, "host-key");
    expect(panel.querySelector('[data-step="host-key"]')).not.toHaveTextContent(/\d s/);
    expect(tcp).not.toHaveTextContent(/\d s/);
  });

  it("ignores progress of another Host's check, and of a check that already ended", async () => {
    const { user, backend } = await ready();
    const panel = await check(user, host);
    progress(backend, host, "dns");
    progress(backend, other, "auth");
    progress(backend, host, "auth", { kind: "mesh" });
    progress(backend, host, "auth", { state: "done" });
    expect(running(panel)).toBe("dns");
  });

  it("shows the result in the same rows once the check answers", async () => {
    const { user, backend } = await ready();
    const panel = await check(user, host);
    progress(backend, host, "auth");
    act(() => backend.answerCheck(host, { host, ok: true, steps: CHECK_STEPS.map((step) => ({ step, status: "ok" as const, message: `${step} fine` })) }));
    expect(await within(panel).findByText(/All checks passed/)).toBeInTheDocument();
    expect(statuses(panel)).toEqual(Array(8).fill("ok"));
    // Progress that comes in after the answer changes nothing.
    progress(backend, host, "tcp");
    expect(statuses(panel)).toEqual(Array(8).fill("ok"));
  });

  it("says where a stopped check stopped", async () => {
    const { user, backend } = await ready();
    const panel = await check(user, host);
    progress(backend, host, "host-key");
    act(() => backend.answerCheck(host, stoppedAt(host, 6)));
    expect(await within(panel).findByText(/Stopped at Host key/)).toBeInTheDocument();
    expect(panel.querySelector('[data-step="host-key"]')).toHaveAttribute("data-stopped");
    expect(panel.querySelectorAll("[data-stopped]")).toHaveLength(1);
  });

  it("keeps the steps when the check gives up, the one under way marked as where it stopped", async () => {
    const { user, backend } = await ready();
    const panel = await check(user, host);
    progress(backend, host, "tcp");
    act(() => backend.answerCheck(host, new BackendCallError("roster serve didn't answer host.check within 90 s", null, null, false, true)));
    expect(await within(panel).findByText(/didn't answer host\.check/)).toBeInTheDocument();
    expect(statuses(panel)).toEqual(["done", "done", "done", "done", "done", "stopped", "pending", "pending"]);
    expect(panel.querySelector('[data-step="tcp"]')).toHaveAttribute("data-stopped");
  });

  it("checking the same Host again while it runs keeps where it is (serve joins the check)", async () => {
    const { user, backend } = await ready();
    await check(user, host);
    progress(backend, host, "dns");
    const panel = await check(user, host);
    expect(running(panel)).toBe("dns");
  });

  it("checking another Host starts over, and the first Host's steps no longer move it", async () => {
    const { user, backend } = await ready();
    await check(user, host);
    progress(backend, host, "dns");
    const panel = await check(user, other);
    expect(statuses(panel)).toEqual(Array(8).fill("pending"));
    progress(backend, host, "tcp");
    expect(running(panel)).toBeNull();
  });

  it("tells a screen reader the step under way once it has run a moment, not every step that flies by", async () => {
    const { user, backend } = await ready();
    const panel = await check(user, host);
    const [step, line] = [...panel.querySelectorAll('[aria-live="polite"]')];
    expect(line).toHaveTextContent(`Checking ${host}…`);
    progress(backend, host, "inventory");
    progress(backend, host, "ssh-config");
    progress(backend, host, "tcp");
    expect(step).toHaveTextContent("");
    await waitFor(() => expect(step).toHaveTextContent("Checking TCP port"));
    act(() => backend.answerCheck(host, stoppedAt(host, 5)));
    // The outcome is the summary line's change (the same element throughout); the step goes quiet.
    await waitFor(() => expect(line).toHaveTextContent("Stopped at TCP port"));
    expect(step).toHaveTextContent("");
    expect(panel.querySelectorAll('[aria-live="polite"]')[1]).toBe(line);
  });
});

describe("the fake's check job", () => {
  it("sends progress as each step starts, up to the step that failed, then answers", async () => {
    const seen: (string | null)[] = [];
    const result: HostCheck = {
      host,
      ok: false,
      steps: CHECK_STEPS.map((step, i) =>
        i < 2 ? { step, status: "ok" as const, message: "fine" } : i === 2 ? { step, status: "fail" as const, message: "no", code: 32 } : { step, status: "skipped" as const, message: "an earlier step failed" },
      ),
    };
    const backend = fakeBackend({ hosts, checks: { [host]: result }, checkSteps: { stepMs: 1 } });
    backend.onJobProgress((j) => seen.push(`${j.state}:${j.at}`));
    expect(await backend.checkHost(host)).toEqual(result);
    expect(seen).toEqual(["running:null", "running:inventory", "running:ssh-config", "running:provider", "done:provider"]);
  });
});
