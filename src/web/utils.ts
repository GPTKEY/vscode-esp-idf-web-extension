/*
 * Project: ESP-IDF Web Extension
 * File Created: Wednesday, 19th June 2024 9:51:13 am
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

import {
  FileSystemError,
  FileType,
  OutputChannel,
  StatusBarAlignment,
  Uri,
  window,
  workspace,
} from "vscode";
import { FlashSectionMessage, PartitionInfo } from "./webserial";
import { Transport, UsbJtagSerialReset } from "esptool-js";

const USB_JTAG_SERIAL_PID = 0x1001;
const FLASH_ARGS_FILE_NAME = "flasher_args.json";

interface FlashFilesConfig {
  flasherArgsUri: Uri;
  filesBaseUri: Uri;
  sourceDescription: string;
}

export const errorNotificationMessage =
  "Build file not found. Make sure to build your ESP-IDF project first and if 'idf.buildPath' is defined, that is correctly set.";
// https://issues.chromium.org/issues/40137537
const webUsbPolyfillClaimError = "Failed to execute 'claimInterface' on 'USBDevice': Unable to claim interface.";

const encoder = new TextEncoder();
export const stringToUInt8Array = function (textString: string) { return encoder.encode(textString); };

export function uInt8ArrayToString(fileBuffer: Uint8Array) {
  let fileBufferString = "";
  for (let i = 0; i < fileBuffer.length; i++) {
    fileBufferString += String.fromCharCode(fileBuffer[i]);
  }
  return fileBufferString;
}

export async function universalReset(transport: Transport) {
  if (!transport) {
    return;
  }
  if ((navigator as any).serial !== undefined) { // WebSerial
    await transport.setDTR(false);
    await sleep(100);
    await transport.setDTR(true);
  } else { // WebUSB polyfill
    new UsbJtagSerialReset(transport).reset();
    if (transport.getPid() === USB_JTAG_SERIAL_PID) {
      await sleep(100);
    }
    await sleep(100);
    // can also use SerialReset twice, but then the chip gets reset 1.5 times
    await transport.setRTS(false);
    await transport.setDTR(false);
    await sleep(100);
    await transport.setDTR(true);
    await transport.setRTS(false);
  }
}

export async function handleMonitorError(outputChnl: OutputChannel, error: any) {
  const rawMessage = ((error as Error).message || String(error)).replace("Error setting up device: ", "");
  const errorType = rawMessage.split(":")[0];
  const errorMessage = rawMessage.replace(`${errorType}: `, "");
  outputChnl.show();
  outputChnl.appendLine("\n");
  if (error instanceof FileSystemError && error.code === "FileNotFound") {
    window.showErrorMessage(errorNotificationMessage);
    outputChnl.appendLine(errorNotificationMessage);
    outputChnl.appendLine(rawMessage);
    return;
  } else if (errorMessage === webUsbPolyfillClaimError) {
    if ((navigator as any).serial) {
      outputChnl.appendLine("Failed to claim interface. Please detach the device from any app that is using it.");
    } else {
      outputChnl.appendLine("Failed to claim interface. Please open the device in a terminal app to detach the driver.");
    }
    return;
  }
  outputChnl.appendLine(rawMessage);
}

export async function getBuildDirectoryFileContent(
  workspaceFolder: Uri,
  ...fileRelativeToBuildPath: string[]
) {
  const resultFilePath = await getBuildDirectoryFileUri(
    workspaceFolder,
    ...fileRelativeToBuildPath
  );
  const resultFileContent = await workspace.fs.readFile(resultFilePath);
  return uInt8ArrayToString(resultFileContent);
}

export async function getBuildDirectoryUri(workspaceFolder: Uri) {
  const candidates: Uri[] = [];
  const configuredBuildPath = workspace
    .getConfiguration("", workspaceFolder)
    .get("idf.buildPath") as string | undefined;

  if (configuredBuildPath && configuredBuildPath.trim().length > 0) {
    const resolvedBuildPath = resolveVariables(
      configuredBuildPath.trim(),
      workspaceFolder
    );
    candidates.push(pathToWorkspaceUri(workspaceFolder, resolvedBuildPath));
  }

  candidates.push(Uri.joinPath(workspaceFolder, "build"));

  const tried: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.toString();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    tried.push(candidate.toString());
    try {
      const stat = await workspace.fs.stat(candidate);
      if (stat.type === FileType.Directory) {
        return candidate;
      }
    } catch (error) {
      // Try the next candidate. A relative idf.buildPath such as "build" used to
      // be resolved as /build in Codespaces; falling back to workspace/build keeps
      // the flash command usable even when the setting is old or incomplete.
    }
  }

  throw FileSystemError.FileNotFound(
    `ESP-IDF build directory not found. Tried: ${tried.join(", ")}`
  );
}

export async function getBuildDirectoryFileUri(
  workspaceFolder: Uri,
  ...fileRelativeToBuildPath: string[]
) {
  const buildDirectory = await getBuildDirectoryUri(workspaceFolder);
  const requestedPath = normalizePath(fileRelativeToBuildPath.join("/"));
  return getFileUriFromBase(workspaceFolder, buildDirectory, requestedPath);
}

export async function getMonitorBaudRate(workspaceFolder: Uri) {
  const projDescContentStr = await getBuildDirectoryFileContent(
    workspaceFolder,
    "project_description.json"
  );
  const projDescFileJson = JSON.parse(projDescContentStr);
  const monitorBaudRateStr = projDescFileJson["monitor_baud"];
  const monitorBaudRateNum = parseInt(monitorBaudRateStr);
  return monitorBaudRateNum;
}

export async function getFlashSectionsForCurrentWorkspace(
  workspaceFolder: Uri,
  outputChannel?: OutputChannel
) {
  const flashFilesConfig = await getFlashFilesConfig(workspaceFolder);
  const flasherArgsContent = await workspace.fs.readFile(
    flashFilesConfig.flasherArgsUri
  );
  const flasherArgsContentStr = uInt8ArrayToString(flasherArgsContent);
  const flashFileJson = JSON.parse(flasherArgsContentStr);

  outputChannel?.appendLine(`Flash files source: ${flashFilesConfig.sourceDescription}`);
  outputChannel?.appendLine(`Flasher args file: ${flashFilesConfig.flasherArgsUri.toString()}`);
  outputChannel?.appendLine(`Flash files base path: ${flashFilesConfig.filesBaseUri.toString()}`);

  const binPromises: Promise<PartitionInfo>[] = [];
  Object.keys(flashFileJson["flash_files"]).forEach((offset) => {
    const fileName = flashFileJson["flash_files"][offset] as string;
    binPromises.push(
      readFlashFileIntoBuffer(
        workspaceFolder,
        flashFilesConfig.filesBaseUri,
        fileName,
        offset,
        outputChannel
      )
    );
  });
  const binaries = await Promise.all(binPromises);
  const message: FlashSectionMessage = {
    sections: binaries,
    flashFreq: flashFileJson["flash_settings"]["flash_freq"],
    flashMode: flashFileJson["flash_settings"]["flash_mode"],
    flashSize: flashFileJson["flash_settings"]["flash_size"],
  };
  return message;
}

export async function readFileIntoBuffer(
  workspaceFolder: Uri,
  name: string,
  offset: string
) {
  const fileBufferString = await getBuildDirectoryFileContent(
    workspaceFolder,
    name
  );
  const fileBufferResult: PartitionInfo = {
    data: fileBufferString,
    name,
    address: parseInt(offset),
  };
  return fileBufferResult;
}

async function getFlashFilesConfig(workspaceFolder: Uri): Promise<FlashFilesConfig> {
  const configuration = workspace.getConfiguration("", workspaceFolder);
  const useCustomFlashFiles = configuration.get(
    "idfWeb.useCustomFlashFiles"
  ) as boolean | undefined;

  if (useCustomFlashFiles) {
    const configuredPath = (
      configuration.get("idfWeb.customFlashFilesPath") as string | undefined
    )?.trim();

    if (!configuredPath) {
      throw FileSystemError.FileNotFound(
        "idfWeb.useCustomFlashFiles is enabled, but idfWeb.customFlashFilesPath is empty."
      );
    }

    const resolvedPath = resolveVariables(configuredPath, workspaceFolder);
    const customUri = pathToWorkspaceUri(workspaceFolder, resolvedPath);
    const customStat = await workspace.fs.stat(customUri);

    if (customStat.type === FileType.Directory) {
      const flasherArgsUri = await getFileUriFromBase(
        workspaceFolder,
        customUri,
        FLASH_ARGS_FILE_NAME
      );
      return {
        flasherArgsUri,
        filesBaseUri: customUri,
        sourceDescription: `custom path setting idfWeb.customFlashFilesPath=${configuredPath}`,
      };
    }

    if (customStat.type === FileType.File) {
      return {
        flasherArgsUri: customUri,
        filesBaseUri: getParentUri(customUri),
        sourceDescription: `custom file setting idfWeb.customFlashFilesPath=${configuredPath}`,
      };
    }

    throw FileSystemError.FileNotFound(
      `Custom flash files path is not a file or directory: ${customUri.toString()}`
    );
  }

  const buildDirectory = await getBuildDirectoryUri(workspaceFolder);
  const flasherArgsUri = await getFileUriFromBase(
    workspaceFolder,
    buildDirectory,
    FLASH_ARGS_FILE_NAME
  );
  return {
    flasherArgsUri,
    filesBaseUri: buildDirectory,
    sourceDescription: "ESP-IDF build output",
  };
}

async function readFlashFileIntoBuffer(
  workspaceFolder: Uri,
  filesBaseUri: Uri,
  name: string,
  offset: string,
  outputChannel?: OutputChannel
) {
  const fileUri = await getFileUriFromBase(workspaceFolder, filesBaseUri, name);
  outputChannel?.appendLine(
    `Loading flash file offset ${offset}: ${name} -> ${fileUri.toString()}`
  );
  const fileBuffer = await workspace.fs.readFile(fileUri);
  const fileBufferResult: PartitionInfo = {
    data: uInt8ArrayToString(fileBuffer),
    name,
    address: parseInt(offset),
  };
  return fileBufferResult;
}

async function getFileUriFromBase(
  workspaceFolder: Uri,
  baseUri: Uri,
  requestedPath: string
) {
  const normalizedRequestedPath = normalizePath(requestedPath);
  const candidates: Uri[] = [];

  if (isAbsolutePath(normalizedRequestedPath) || isUriLike(normalizedRequestedPath)) {
    candidates.push(pathToWorkspaceUri(workspaceFolder, normalizedRequestedPath));
  } else {
    const parts = splitPath(normalizedRequestedPath);
    candidates.push(Uri.joinPath(baseUri, ...parts));
    candidates.push(Uri.joinPath(workspaceFolder, ...parts));
  }

  const tried: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.toString();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    tried.push(candidate.toString());
    try {
      const stat = await workspace.fs.stat(candidate);
      if (stat.type === FileType.File) {
        return candidate;
      }
    } catch (error) {
      // Continue to alternative locations.
    }
  }

  throw FileSystemError.FileNotFound(
    `Build file not found: ${normalizedRequestedPath}. Tried: ${tried.join(", ")}`
  );
}

export function resolveVariables(configPath: string, scope: Uri) {
  const regexp = /\$\{(.*?)\}/g; // Find ${anything}
  return configPath.replace(regexp, (match: string) => {
    if (match.includes("workspaceFolder")) {
      return scope.fsPath === "/" || scope.fsPath === "\\" ? "" : scope.fsPath;
    }
    return match;
  });
}

function pathToWorkspaceUri(workspaceFolder: Uri, pathOrUri: string) {
  const normalized = normalizePath(pathOrUri);

  if (isUriLike(normalized) && !isWindowsAbsolutePath(normalized)) {
    const parsed = Uri.parse(normalized);
    return parsed.with({
      scheme: workspaceFolder.scheme,
      authority: workspaceFolder.authority,
    });
  }

  if (isAbsolutePath(normalized)) {
    return workspaceFolder.with({ path: normalized });
  }

  return Uri.joinPath(workspaceFolder, ...splitPath(normalized));
}

function getParentUri(uri: Uri) {
  const parts = uri.path.split("/").filter((part) => part.length > 0);
  const parentPath = `/${parts.slice(0, -1).join("/")}`;
  return uri.with({ path: parentPath === "" ? "/" : parentPath });
}

function normalizePath(pathValue: string) {
  const normalized = pathValue.replace(/\\/g, "/");
  if (isUriLike(normalized) && !isWindowsAbsolutePath(normalized)) {
    return normalized;
  }
  return normalized.replace(/\/+/g, "/");
}

function splitPath(pathValue: string) {
  return normalizePath(pathValue).split("/").filter((part) => part.length > 0 && part !== ".");
}

function isUriLike(pathValue: string) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(pathValue);
}

function isAbsolutePath(pathValue: string) {
  return pathValue.startsWith("/") || isWindowsAbsolutePath(pathValue);
}

function isWindowsAbsolutePath(pathValue: string) {
  return /^[a-zA-Z]:\//.test(pathValue);
}

export function createStatusBarItem(
  icon: string,
  tooltip: string,
  cmd: string,
  priority: number
) {
  const alignment: StatusBarAlignment = StatusBarAlignment.Left;
  const statusBarItem = window.createStatusBarItem(alignment, priority);
  statusBarItem.text = icon;
  statusBarItem.tooltip = tooltip;
  statusBarItem.command = cmd;
  const enableStatusBarIcons = workspace
    .getConfiguration("")
    .get("idfWeb.enableStatusBarIcons") as boolean;
  if (enableStatusBarIcons) {
    statusBarItem.show();
  }
  return statusBarItem;
}

export async function sleep(ms: number): Promise<any> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
