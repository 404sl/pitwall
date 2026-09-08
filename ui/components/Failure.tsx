import type { ReactNode } from "react";
import { strings } from "../strings.js";

interface FailureProps {
  message: string;
  heading?: string;
  children?: ReactNode;
}

export function Failure({ message, heading, children }: FailureProps) {
  return (
    <div className="pw-failure">
      <h2 className="pw-failure__head">{heading ?? strings.failure.heading}</h2>
      <p className="pw-failure__message">{message}</p>
      {children}
    </div>
  );
}
