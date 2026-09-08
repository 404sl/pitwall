import { strings } from "../strings.js";

export function Failure({ message }: { message: string }) {
  return (
    <div className="pw-failure">
      <h2 className="pw-failure__head">{strings.failure.heading}</h2>
      <p className="pw-failure__message">{message}</p>
    </div>
  );
}
