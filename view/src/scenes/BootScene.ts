import { Text } from "pixi.js";
import { Scene } from "./Scene";
import type { GameContext } from "../GameContext";

/** Placeholder scene proving the copied scene + panel infrastructure boots.
 *  The real scenes (login, main world) are rebuilt on top of this framework. */
export class BootScene extends Scene {
  private label = new Text({
    text: "view — scene + panel infrastructure online",
    style: { fill: 0x9fb3c8, fontSize: 18 },
  });

  onEnter(_ctx: GameContext): void {
    this.root.addChild(this.label);
    this.layout();
  }

  onResize(_width: number, _height: number): void {
    this.layout();
  }

  private layout(): void {
    this.label.x = Math.round((this.width - this.label.width) / 2);
    this.label.y = Math.round((this.height - this.label.height) / 2);
  }
}
