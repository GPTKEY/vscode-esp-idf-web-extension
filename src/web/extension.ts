/*
 * Project: ESP-IDF Web Extension
 * File Created: Monday, 17th June 2024 2:36:19 pm
 * Copyright 2024 Espressif Systems (Shanghai) CO LTD
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as vscode from "vscode";

const statusBarItems: { [key: string]: vscode.StatusBarItem } = {};

export function activate(context: vscode.ExtensionContext) {
  if (
    typeof navigator !== "undefined" &&
    (navigator as any).serial === undefined &&
    (navigator as any).usb
  ) {
    console.log("WebSerial not supported. Polyfilling with WebUSB");
  }

  const flashDisposable = vscode.commands.registerCommand(
    "espIdfWeb.flash",
    async () => {
      const { IDFWebMonitorTerminal } = await import("./monitorTerminalManager");
      const { IDFWebSerialPort } = await import("./portManager");
      const { flashWithWebSerial } = await import("./webserial");

      if (IDFWebMonitorTerminal.exists()) {
        await IDFWebMonitorTerminal.dispose();
      }
      const workspaceFolder = await getWorkspaceFolder();
      if (!workspaceFolder) {
        return;
      }
      const port = await IDFWebSerialPort.init();
      if (workspaceFolder && port) {
        await flashWithWebSerial(workspaceFolder.uri, port);
      }
    }
  );

  context.subscriptions.push(flashDisposable);

  const monitorDisposable = vscode.commands.registerCommand(
    "espIdfWeb.monitor",
    async () => {
      const { IDFWebMonitorTerminal } = await import("./monitorTerminalManager");
      const { IDFWebSerialPort } = await import("./portManager");
      const { monitorWithWebserial } = await import("./monitor");

      if (IDFWebMonitorTerminal.exists()) {
        await IDFWebMonitorTerminal.dispose();
      }
      const workspaceFolder = await getWorkspaceFolder();
      if (!workspaceFolder) {
        return;
      }
      const port = await IDFWebSerialPort.init();
      if (workspaceFolder && port) {
        await monitorWithWebserial(workspaceFolder.uri, port);
      }
    }
  );
  context.subscriptions.push(monitorDisposable);

  const flashMonitorDisposable = vscode.commands.registerCommand(
    "espIdfWeb.flashAndMonitor",
    async () => {
      const { IDFWebMonitorTerminal } = await import("./monitorTerminalManager");
      const { IDFWebSerialPort } = await import("./portManager");
      const { flashAndMonitor } = await import("./webserial");

      if (IDFWebMonitorTerminal.exists()) {
        await IDFWebMonitorTerminal.dispose();
      }
      const workspaceFolder = await getWorkspaceFolder();
      if (!workspaceFolder) {
        return;
      }
      const port = await IDFWebSerialPort.init();
      if (workspaceFolder && port) {
        await flashAndMonitor(workspaceFolder.uri, port);
      }
    }
  );
  context.subscriptions.push(flashMonitorDisposable);

  const selectPort = vscode.commands.registerCommand(
    "espIdfWeb.selectPort",
    async () => {
      const { IDFWebSerialPort } = await import("./portManager");
      await IDFWebSerialPort.init();
    }
  );
  context.subscriptions.push(selectPort);

  const disposePort = vscode.commands.registerCommand(
    "espIdfWeb.disposePort",
    async () => {
      const { IDFWebMonitorTerminal } = await import("./monitorTerminalManager");
      const { IDFWebSerialPort } = await import("./portManager");
      const { isFlashing } = await import("./webserial");

      if (IDFWebMonitorTerminal.exists()) {
        await IDFWebMonitorTerminal.dispose();
      }
      if (isFlashing) {
        vscode.window.showErrorMessage(
          "Wait for ESP-IDF Web flash to finish before disconnect."
        );
        return;
      }
      await IDFWebSerialPort.disconnect();
    }
  );
  context.subscriptions.push(disposePort);

  createStatusBarItems();
  context.subscriptions.push(
    statusBarItems["flash"],
    statusBarItems["monitor"]
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration("idfWeb.enableStatusBarIcons")) {
        const enableStatusBarIcons = vscode.workspace
          .getConfiguration("")
          .get("idfWeb.enableStatusBarIcons") as boolean;
        if (enableStatusBarIcons) {
          statusBarItems["flash"].show();
          statusBarItems["monitor"].show();
        } else {
          statusBarItems["flash"].hide();
          statusBarItems["monitor"].hide();
        }

        try {
          const { IDFWebSerialPort } = await import("./portManager");
          if (IDFWebSerialPort.statusBarItem) {
            if (enableStatusBarIcons) {
              IDFWebSerialPort.statusBarItem.show();
            } else {
              IDFWebSerialPort.statusBarItem.hide();
            }
          }
        } catch (error) {
          console.warn("Unable to update ESP-IDF Web serial port status bar item", error);
        }
      }
    })
  );
}

export async function deactivate() {
  try {
    const { IDFWebSerialPort } = await import("./portManager");
    await IDFWebSerialPort.disconnect();
  } catch (error) {
    console.warn("Unable to disconnect ESP-IDF Web serial port during deactivation", error);
  }
}

function createStatusBarItems() {
  statusBarItems["flash"] = createStatusBarItem(
    `$(zap)`,
    "ESP-IDF-Web Flash",
    "espIdfWeb.flash",
    94
  );
  statusBarItems["monitor"] = createStatusBarItem(
    "$(device-desktop)",
    "ESP-IDF-Web Monitor",
    "espIdfWeb.monitor",
    93
  );
}

function createStatusBarItem(
  icon: string,
  tooltip: string,
  cmd: string,
  priority: number
) {
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    priority
  );
  statusBarItem.text = icon;
  statusBarItem.tooltip = tooltip;
  statusBarItem.command = cmd;
  const enableStatusBarIcons = vscode.workspace
    .getConfiguration("")
    .get("idfWeb.enableStatusBarIcons") as boolean;
  if (enableStatusBarIcons) {
    statusBarItem.show();
  }
  return statusBarItem;
}

async function getWorkspaceFolder() {
  if (!vscode.workspace.workspaceFolders) {
    vscode.window.showInformationMessage(
      "No workspace folder opened. Open a folder first."
    );
    return;
  }
  let workspaceFolder;
  if (vscode.workspace.workspaceFolders.length === 1) {
    workspaceFolder = vscode.workspace.workspaceFolders[0];
  } else {
    workspaceFolder = await vscode.window.showWorkspaceFolderPick({
      placeHolder: `Pick Workspace Folder to use`,
    });
  }
  return workspaceFolder;
}
