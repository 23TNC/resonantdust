import type { GameContext } from "../../GameContext";
import { WorldScene } from "../world/WorldScene";
import { Scene } from "../Scene";
import { FormOverlay } from "./FormOverlay";
import {
  ENVIRONMENTS,
  gateUrlFor,
  httpBaseFor,
  setCurrentEnvironment,
  type Environment,
} from "../../client/environments";
import { initContent } from "../../game/definitions/contentBoot";
import { initGlobals } from "../../game/definitions/globals";

type Mode = "login" | "create";

/** Wire Enter on an input to a callback — pressing Enter fires the primary
 *  action (Login or Create depending on mode). */
function attachEnterHandler(input: HTMLInputElement, onSubmit: () => void): void {
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    onSubmit();
  });
}

/**
 * Trust-on-first-use login / create-user form. Login routes through the Rust
 * `client` core (wasm) — `ctx.client.login(name)` — which owns the gate
 * connection. The user picks which **environment** (gate) to connect to via the
 * Server dropdown; that selection points the client at the env's gate URL before
 * login (`ctx.client.setGateUrl`). The server-side `claim_or_login` does both
 * create and login, so "Create" and "Login" hit the same path (the mode toggle
 * is just a UX affordance now that passwords are gone).
 *
 * The form lives in a DOM overlay (`FormOverlay`) parented to the canvas host.
 */
export class LoginScene extends Scene {
  private overlay!: FormOverlay;
  private mode: Mode = "login";
  private busy = false;
  /** Carried across mode switches so the user doesn't retype. Dev-time prefill
   *  of the developer account (unlocks the right-click card menu — see
   *  `WasmClient.isDeveloper`); drop to `""` for real users. */
  private rememberedUsername = "Developer";
  /** Carried across mode switches so the chosen gate sticks. Defaults to `test`
   *  (the harness gate) so a dev session lands there by default rather than
   *  accidentally opening dev/claude. */
  private rememberedServer: Environment = "test";

  onEnter(ctx: GameContext): void {
    this.overlay = new FormOverlay(ctx.uiEditMode);
    this.overlay.mount();
    this.render(ctx);
  }

  onExit(): void {
    this.overlay.unmount();
  }

  private render(ctx: GameContext): void {
    this.overlay.clear();

    const usernameInput = this.overlay.addInput("Username", "text", this.rememberedUsername);
    const serverSelect = this.overlay.addSelect("Server", ENVIRONMENTS, this.rememberedServer);
    serverSelect.addEventListener("change", () => {
      this.rememberedServer = serverSelect.value as Environment;
    });

    const submit = () => {
      const username = usernameInput.value.trim();
      const server = serverSelect.value as Environment;
      if (this.mode === "create") this.doCreate(ctx, username, server);
      else this.doLogin(ctx, username, server);
    };

    if (this.mode === "create") {
      this.overlay.addButton("Create", submit);
      this.overlay.addButton("Back", () =>
        this.switchMode("login", usernameInput.value.trim(), serverSelect.value as Environment, ctx),
      );
    } else {
      this.overlay.addButton("Login", submit);
      this.overlay.addButton("Create user", () =>
        this.switchMode("create", usernameInput.value.trim(), serverSelect.value as Environment, ctx),
      );
    }
    attachEnterHandler(usernameInput, submit);

    this.overlay.attachStatus();
    this.overlay.setStatus(
      this.mode === "create"
        ? "Pick a username and a server to create on."
        : "Pick a username and a server to log in.",
    );

    if (usernameInput.value === "") usernameInput.focus();
  }

  private switchMode(next: Mode, currentUsername: string, server: Environment, ctx: GameContext): void {
    if (this.busy) return;
    this.rememberedUsername = currentUsername;
    this.rememberedServer = server;
    this.mode = next;
    this.render(ctx);
  }

  private async doLogin(ctx: GameContext, username: string, server: Environment): Promise<void> {
    if (this.busy) return;
    if (username === "") {
      this.overlay.setStatus("Username is required.", "error");
      return;
    }
    this.busy = true;
    this.rememberedServer = server;
    this.overlay.setStatus(`Logging in as ${username} on ${server}…`);
    try {
      // Point the wasm client at the selected environment's gate, then log in —
      // the client owns the connection.
      setCurrentEnvironment(server);
      ctx.client.setGateUrl(gateUrlFor(server));
      const { playerId } = await ctx.client.login(username);
      // Load the DSL content runtime (the render VM) from the SAME gate before
      // entering the world, then seed the `<globals>` cache it provides.
      this.overlay.setStatus(`Loading content for ${server}…`);
      await initContent(httpBaseFor(server));
      initGlobals();
      this.overlay.setStatus(`Logged in as ${username} on ${server} (player ${playerId}).`, "success");
      // Into the world. `onExit` unmounts the form.
      ctx.scenes.change(new WorldScene()).catch((err) => {
        console.error("[LoginScene] scene change failed", err);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.overlay.setStatus(`Login failed: ${message}`, "error");
      console.error("[LoginScene] login failed", err);
      this.busy = false;
    }
  }

  private async doCreate(ctx: GameContext, username: string, server: Environment): Promise<void> {
    if (this.busy) return;
    if (username === "") {
      this.overlay.setStatus("Username is required.", "error");
      return;
    }
    this.busy = true;
    this.rememberedServer = server;
    this.overlay.setStatus(`Creating user ${username} on ${server}…`);
    try {
      // `claim_or_login` is trust-on-first-use: an unused name creates the player,
      // an existing one logs in. Create then bounce back to the login form.
      setCurrentEnvironment(server);
      ctx.client.setGateUrl(gateUrlFor(server));
      await ctx.client.login(username);
      this.rememberedUsername = username;
      this.mode = "login";
      this.busy = false;
      this.render(ctx);
      this.overlay.setStatus(`User ${username} ready on ${server}. Log in to continue.`, "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.overlay.setStatus(`Create failed: ${message}`, "error");
      console.error("[LoginScene] create failed", err);
      this.busy = false;
    }
  }
}
