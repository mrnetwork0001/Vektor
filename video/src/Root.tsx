import React from "react";
import { Composition } from "remotion";
import { Film } from "./Film";
import { T } from "./timing";

export const Root: React.FC = () => (
  <Composition id="Vektor" component={Film} durationInFrames={T.totalFrames} fps={T.fps} width={1920} height={1080} />
);
