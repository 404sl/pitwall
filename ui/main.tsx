import { createRoot } from "react-dom/client";

// PLACEHOLDER. This file exists so the toolchain is verifiably wired up - a build
// nobody has run is not a build that works. The console itself is a separate piece
// of work and replaces everything below.
function App() {
  return <p>Pitwall console - not built yet.</p>;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
