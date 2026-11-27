import "./styles/tokens.css";
import "./styles/base.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { readServiceOrigin } from "./api/serviceOrigin";
import { copy } from "./copy";
import { ConfigError, getUserId } from "./identity";

function initialize() {
  const root = createRoot(document.getElementById("root")!);
  try {
    getUserId();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    root.render(<p role="alert">The Axis user is not configured. Set VITE_AXIS_USER to a value such as usr_alice.</p>);
    return;
  }
  try {
    readServiceOrigin(import.meta.env.VITE_AXIS_SERVICE_ORIGIN);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    root.render(<p role="alert">{copy["opening.serviceInvalid"]}</p>);
    return;
  }
  root.render(<App />);
}

initialize();
