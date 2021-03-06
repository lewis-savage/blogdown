import { mainWindow, openModal } from "./index";
import * as fs from "fs";
const fsPromises = fs.promises;
import Store from "electron-store";
import { StoreFormat } from "./interfaces";
import { schema } from "./store";
import * as pathF from "path";
import chokidar from "chokidar";
import { Mutex } from "async-mutex";

import { ipcMain } from "electron";
import { cssTemplate, examplePostTemplate } from "./templates";

const store = new Store<StoreFormat>({ schema: schema });

const configFileName = "blogdown.config.json";

interface ProjectConfig {
    projectName: string;
    title: string;
    icon: string;
    postsDirectory: string;
    imagesDirectory: string;
}

export interface Directory {
    path: string;
    files: string[];
    directories: Directory[];
    expanded: boolean;
}

class Project {
    path: string;
    config: ProjectConfig;
    directory: Directory;
    openDirectories: string[] = [];

    private fsWatcher: chokidar.FSWatcher;
    directoryMutex = new Mutex();
    constructor(path: string) {
        this.path = path;
    }

    async loadConfig() {
        const data = await fsPromises.readFile(
            pathF.join(this.path, configFileName)
        );
        this.config = <ProjectConfig>JSON.parse(data.toString());
    }

    async readDirectory() {
        this.directory = initDirectory(this.path);
        this.directory.expanded = true;
        await trawlDirectory(this.directory);
        mainWindow.webContents.send("project-loaded", this.directory);
        mainWindow.webContents.send("render-sidebar", this.directory);
        this.fsWatcher = chokidar.watch(this.path).on("all", async () => {
            await this.directoryMutex.runExclusive(async () => {
                this.directory = initDirectory(this.path);
                await trawlDirectory(this.directory);
                this.updateOpenDirectories(this.directory);
                mainWindow.webContents.send("render-sidebar", this.directory);
            });
        });
    }

    updateOpenDirectories(dir = this.directory) {
        if (this.openDirectories.includes(dir.path)) dir.expanded = true;
        for (const directory of dir.directories) {
            this.updateOpenDirectories(directory);
        }
    }

    closeProject() {
        this.fsWatcher.close();
    }
}

let currentProject: Project;

function initDirectory(path: string) {
    return <Directory>{
        path: path,
        files: [],
        directories: [],
        expanded: false,
    };
}

function printDirectory(dir: Directory, indent = 0): void {
    for (const directory of dir.directories) {
        if (directory.expanded) {
            console.log("expanded");
        }
        console.log(
            " ".repeat(indent),
            directory.path.substring(directory.path.lastIndexOf(pathF.sep))
        );
        printDirectory(directory, indent + 1);
    }
    for (const file of dir.files) {
        console.log(" ".repeat(indent), file);
    }
}

async function trawlDirectory(dir: Directory) {
    const files = await fsPromises.readdir(dir.path);
    for (const file of files) {
        const stats = await fsPromises.lstat(pathF.join(dir.path, file));
        if (stats.isDirectory()) {
            dir.directories.push(initDirectory(pathF.join(dir.path, file)));
        } else {
            dir.files.push(pathF.join(dir.path, file));
        }
    }
    for (const directory of dir.directories) {
        await trawlDirectory(directory);
    }
}

export function lastOpenProject(): string {
    console.log(store.get("lastOpenedProject", ""));
    return store.get("lastOpenedProject", "");
}

export async function openProject(dir: string, autoLoad = false) {
    if (await directoryIsProject(dir)) {
        openProjectProperly(dir);
    } else if (!autoLoad) {
        const response = openModal(
            "There isn't a project in this directory, would you like to make one?",
            ["Yes", "No"]
        );
        if (response == 0) {
            await intialiseProject(dir);
            await openProjectProperly(dir);
        } else {
            console.log("Don't make proj");
        }
    }
}

async function openProjectProperly(dir: string) {
    currentProject?.closeProject();
    const p = new Project(dir);
    await p.loadConfig();
    await p.readDirectory();

    store.set("lastOpenedProject", dir);
    currentProject = p;
}

async function directoryIsProject(dir: string) {
    try {
        const files = await fsPromises.readdir(dir);
        if (files.includes(configFileName)) {
            // Verify config file first
            return true;
        }
    } catch {
        return false;
    }
}

const exampleConfig = `{
	"projectName": "example",
	"title": "Blog Name",
	"postsDirectory": "posts",
	"imagesDirectory": "img",
	"icon": "favicon.ico",
    "css": "style.css"
}`;

async function intialiseProject(dir: string) {
    await fsPromises.writeFile(pathF.join(dir, configFileName), exampleConfig);
    try {
        await fsPromises.mkdir(pathF.join(dir, "posts"));
    } catch {
        console.log("Posts directory already exists");
    }
    try {
        await fsPromises.mkdir(pathF.join(dir, "css"));
    } catch {
        console.log("Css directory already exists");
    }
    try {
        await fsPromises.mkdir(pathF.join(dir, "js"));
    } catch {
        console.log("Js directory already exists");
    }
    await fsPromises.writeFile(
        pathF.join(dir, "css", "style.css"),
        cssTemplate
    );
    await fsPromises.writeFile(
        pathF.join(dir, "posts", "example.md"),
        examplePostTemplate
    );
}

function fileIsInActiveDirectory(file: string) {
    return file.includes(currentProject.directory.path);
}

ipcMain.on("load-file-contents", async (event, file: string) => {
    if (!fileIsInActiveDirectory) return;
    const fileContent = await fsPromises.readFile(file);
    event.sender.send("file-contents", file, fileContent.toString());
});

ipcMain.on("save-file", async (event, file: string, contents: string) => {
    if (!fileIsInActiveDirectory) return;
    await fsPromises.writeFile(file, contents);
    event.sender.send("file-saved", file, contents);
});

ipcMain.on("create-post", async (event, fileName: string, contents: string) => {
    const filePath = pathF.join(currentProject.path, "posts", fileName + ".md");
    await fsPromises.writeFile(filePath, contents);
    event.sender.send("file-contents", filePath, contents);
});

ipcMain.on("rename-file", async (event, file: string, newName: string) => {
    if (!fileIsInActiveDirectory) return;
    if (file.includes(currentProject.directory.path)) {
        await fsPromises.rename(file, newName);
    }
});

ipcMain.on("open-directory", (event, path) => {
    if (!fileIsInActiveDirectory) return;
    if (currentProject.openDirectories.includes(path)) {
        const index = currentProject.openDirectories.indexOf(path);
        currentProject.openDirectories.splice(index, 1);
    } else {
        currentProject.openDirectories.push(path);
    }
});

ipcMain.on("request-css", async (event) => {
    const css = await fsPromises.readFile(
        pathF.join(currentProject.directory.path, "css", "style.css")
    );
    event.sender.send("css-content", css.toString());
});

export async function createFile(fileName: string, directory: Directory) {
    if (!fileIsInActiveDirectory) return;
    await fsPromises.writeFile(pathF.join(directory.path, fileName), "");
}

function getFileNameWithoutExtension(file: string) {
    return file.substring(0, file.lastIndexOf("."));
}

function getExtension(file: string) {
    return file.substring(file.lastIndexOf("."));
}

export async function cloneFile(file: string) {
    if (!fileIsInActiveDirectory) return;
    const fileExtension = getExtension(file);
    let attempt = 1;
    let nameFound = false;
    while (!nameFound) {
        try {
            await fsPromises.stat(
                `${getFileNameWithoutExtension(
                    file
                )}(${attempt})${fileExtension}`
            );
            attempt += 1;
        } catch {
            nameFound = true;
        }
    }
    await fsPromises.copyFile(
        file,
        `${getFileNameWithoutExtension(file)}(${attempt})${fileExtension}`
    );
}

export async function deleteFile(file: string) {
    if (!fileIsInActiveDirectory) return;
    await fsPromises.rm(file, {});
}
