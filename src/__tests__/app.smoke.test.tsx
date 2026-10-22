// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

// Live network calls are stubbed: demo mode must work fully offline.
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => "" })));
  class FakeWS { onopen: any; onmessage: any; onclose: any; onerror: any; readyState = 0; send() {} close() {} }
  (FakeWS as any).OPEN = 1; (FakeWS as any).CONNECTING = 0;
  vi.stubGlobal("WebSocket", FakeWS);
  vi.stubGlobal("confirm", () => true);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function loadApp() {
  const { default: App } = await import("../App");
  return App;
}

describe("Vektor app (demo mode)", () => {
  it("renders, deploys a grid, fills rungs as the demo market moves, and the shield reacts to a crash", async () => {
    const App = await loadApp();
    render(<App />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/Vektor/);
    expect(screen.getByText("DEMO")).toBeTruthy();

    // Let the demo market tick a few times so the ladder has history
    await act(async () => { vi.advanceTimersByTime(3000); });

    // Deploy the grid with default settings
    const deploy = screen.getByRole("button", { name: /Deploy .*rungs/ });
    await act(async () => { fireEvent.click(deploy); });
    expect(screen.getByText(/Running grid/)).toBeTruthy();
    expect(screen.getByText(/Stop grid/)).toBeTruthy();

    // Second grid on another symbol → both listed in Active grids
    const select = document.querySelector("select.market-select") as HTMLSelectElement;
    await act(async () => { fireEvent.change(select, { target: { value: "SOL-USD" } }); });
    await act(async () => { vi.advanceTimersByTime(1500); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Deploy .*rungs/ })); });
    expect(screen.getByText(/Active grids \(2\)/)).toBeTruthy();
    await act(async () => { fireEvent.change(select, { target: { value: "ADA-USD" } }); });
    expect(screen.getByText(/Running grid/)).toBeTruthy();

    // Heatmap view renders a canvas
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Liquidity heatmap/ })); });
    expect(document.querySelector("canvas.heatmap")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Ladder$/ })); });

    // Crash the market: buy rungs fill, inventory builds, shield should log
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Flash crash/ })); });
    await act(async () => { vi.advanceTimersByTime(25 * 500 + 2000); });

    // Positions table shows the long we accumulated (or it was trimmed/flattened)
    const logs = document.querySelectorAll(".log-line");
    expect(logs.length).toBeGreaterThan(1);
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/Entry BUY/);

    // Shield tab: at 10x a −12% crash pushes the long inside the 8% buffer → Rule A / B must have fired
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Aegis Shield/ })); });
    expect(screen.getByText(/Aegis liquidation shield/)).toBeTruthy();
    const shieldLog = document.querySelector(".log.tall")?.textContent ?? "";
    expect(shieldLog).toMatch(/Rule A|Rule B/);

    // Funding tab renders ranked markets with APR
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Funding Harvester/ })); });
    expect(screen.getAllByText(/ADA-USD/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Launch delta-neutral hedge/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText(/Launch delta-neutral hedge/)); });
    await act(async () => { vi.advanceTimersByTime(4000); });
    expect(document.body.textContent).toMatch(/DONE|Placing slice/);

    // Judge tour runs through its steps and ends on its own
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Judge tour/ })); });
    expect(document.querySelector(".tour-bar")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(document.querySelector(".tour-bar")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Grid Studio/ })); });

    // Panic opens the themed confirm dialog (not window.confirm), then flattens
    await act(async () => { fireEvent.click(screen.getAllByText("PANIC")[0]); });
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Flatten everything/ })); });
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(document.body.textContent).toMatch(/No open positions/);
  });
});
