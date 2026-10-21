import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { MemberWindow } from "./CollaborationWorkspace";
import { TransientScrollbars } from "./TransientScrollbars";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <TransientScrollbars />
    {new URLSearchParams(location.search).get("member") === "1" ? <MemberWindow /> : <App />}
  </React.StrictMode>,
);
