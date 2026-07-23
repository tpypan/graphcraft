import { execFile } from "node:child_process";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileGraph, compileRunContract } from "@graphcraft/core";
import {
  ensurePrivateDirectory,
  finalizePrivateDirectoryMutation,
  hardenPrivateFile,
  hardenPrivateTree,
  preparePrivateDirectoryMutation,
  privateEntryIdentityFingerprint,
  privatePublicationIdentityFingerprint,
  publishPrivateFileAtomic,
  readPrivateFileBounded,
  readRegularFileBounded,
  validatePrivatePath,
  writePrivateJsonAtomic,
} from "./secure-fs.ts";
import { writeJsonAtomic } from "./json.ts";
import { RunStore } from "./store.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "graphcraft-secure-fs-test-"));
  temporaryRoots.push(root);
  return root;
}

async function expectMode(path: string, mode: number): Promise<void> {
  expect((await stat(path)).mode & 0o777).toBe(mode);
}

async function runWindowsPowerShell(path: string, script: string): Promise<void> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error("Windows test requires SystemRoot");
  await new Promise<void>((resolve, reject) => {
    execFile(
      win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        env: { ...process.env, GRAPHCRAFT_ACL_TEST_PATH: path },
      },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

async function grantWindowsEveryone(path: string): Promise<void> {
  await runWindowsPowerShell(
    path,
    String.raw`
$ErrorActionPreference = 'Stop'
$path = [Environment]::GetEnvironmentVariable('GRAPHCRAFT_ACL_TEST_PATH')
$attributes = [System.IO.File]::GetAttributes($path)
$isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
if ($isDirectory) {
  $item = [System.IO.DirectoryInfo]::new($path)
  $inheritance = ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit)
} else {
  $item = [System.IO.FileInfo]::new($path)
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
}
$acl = $item.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access)
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $everyone,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  $inheritance,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
[void]$acl.AddAccessRule($rule)
$item.SetAccessControl($acl)
`,
  );
}

async function runDarwinTool(executable: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(executable, args, { encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function darwinAclListing(path: string): Promise<string> {
  return await runDarwinTool("/bin/ls", ["-lde", path]);
}

async function expectWindowsOwnerOnly(path: string): Promise<void> {
  await runWindowsPowerShell(
    path,
    String.raw`
$ErrorActionPreference = 'Stop'
$path = [Environment]::GetEnvironmentVariable('GRAPHCRAFT_ACL_TEST_PATH')
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$attributes = [System.IO.File]::GetAttributes($path)
$isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
if ($isDirectory) {
  $item = [System.IO.DirectoryInfo]::new($path)
} else {
  $item = [System.IO.FileInfo]::new($path)
}
$sections = ([System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner)
$acl = $item.GetAccessControl($sections)
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
$expectedInheritance = if ($isDirectory) {
  ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit)
} else {
  [System.Security.AccessControl.InheritanceFlags]::None
}
if (-not $acl.AreAccessRulesProtected -or $owner.Value -ne $sid.Value -or
    $rules.Count -ne 1 -or $rules[0].IsInherited -or
    $rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
    $rules[0].FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or
    $rules[0].InheritanceFlags -ne $expectedInheritance -or
    $rules[0].PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None -or
    $rules[0].IdentityReference.Value -ne $sid.Value) {
  throw 'Owner-only ACL assertion failed'
}
`,
  );
}

async function expectWindowsOwnerExclusive(path: string): Promise<void> {
  await runWindowsPowerShell(
    path,
    String.raw`
$ErrorActionPreference = 'Stop'
$path = [Environment]::GetEnvironmentVariable('GRAPHCRAFT_ACL_TEST_PATH')
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$item = [System.IO.FileInfo]::new($path)
$sections = ([System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner)
$acl = $item.GetAccessControl($sections)
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($acl.AreAccessRulesProtected -or $owner.Value -ne $sid.Value -or
    $rules.Count -ne 1 -or -not $rules[0].IsInherited -or
    $rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
    $rules[0].FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or
    $rules[0].InheritanceFlags -ne [System.Security.AccessControl.InheritanceFlags]::None -or
    $rules[0].PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None -or
    $rules[0].IdentityReference.Value -ne $sid.Value) {
  throw 'Owner-exclusive ACL assertion failed'
}
`,
  );
}

describe("secure filesystem permissions", () => {
  it("keys the Windows ACL cache by stable object identity, not mutable timestamps", () => {
    const before = {
      dev: 11n,
      ino: 22n,
      birthtimeNs: 33n,
      ctimeNs: 44n,
      mtimeNs: 55n,
    };
    const afterWrite = {
      ...before,
      ctimeNs: 66n,
      mtimeNs: 77n,
    };
    const fingerprint = privateEntryIdentityFingerprint(before);

    expect(fingerprint).toBe("11:22:33");
    expect(privateEntryIdentityFingerprint(afterWrite)).toBe(fingerprint);
    expect(privateEntryIdentityFingerprint({ ...before, ino: 23n })).not.toBe(fingerprint);
    expect(privateEntryIdentityFingerprint({ ...before, birthtimeNs: 34n })).not.toBe(fingerprint);
    expect(privateEntryIdentityFingerprint({ ...before, ino: 0n })).toBeUndefined();
  });

  it("compares Windows atomic publications by device and nonzero inode instead of birth time", () => {
    const before = { dev: 11n, ino: 22n, birthtimeNs: 33n };
    const fingerprint = privatePublicationIdentityFingerprint(before);

    expect(fingerprint).toBe("11:22");
    expect(privatePublicationIdentityFingerprint({ ...before, birthtimeNs: 34n })).toBe(
      fingerprint,
    );
    expect(privatePublicationIdentityFingerprint({ ...before, dev: 12n })).not.toBe(fingerprint);
    expect(privatePublicationIdentityFingerprint({ ...before, ino: 23n })).not.toBe(fingerprint);
    expect(privatePublicationIdentityFingerprint({ ...before, ino: 0n })).toBeUndefined();
  });

  it("reads a validated private file within its explicit byte limit", async () => {
    const root = await temporaryRoot();
    const file = join(root, "private.txt");
    await writeFile(file, "private bytes\n");

    await expect(readPrivateFileBounded(file, 14, root)).resolves.toEqual(
      Buffer.from("private bytes\n"),
    );
  });

  it("rejects a private file larger than its explicit byte limit", async () => {
    const root = await temporaryRoot();
    const file = join(root, "oversized.txt");
    await writeFile(file, "too large");

    await expect(readPrivateFileBounded(file, 8, root)).rejects.toThrow(
      "Private file exceeds its 8-byte bounded read limit",
    );
  });

  it("refuses bounded reads through symbolic and hard links", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source.txt");
    const symbolic = join(root, "symbolic.txt");
    const hard = join(root, "hard.txt");
    await writeFile(source, "shared\n");
    await symlink(source, symbolic, "file");
    await link(source, hard);

    await expect(readPrivateFileBounded(symbolic, 1024, root)).rejects.toThrow(
      "Refusing to harden symbolic link",
    );
    await expect(readPrivateFileBounded(hard, 1024, root)).rejects.toThrow(
      "Refusing to harden multiply linked file",
    );
    await expect(readRegularFileBounded(hard, 1024)).resolves.toEqual(Buffer.from("shared\n"));
  });

  it.skipIf(process.platform === "win32")(
    "treats backslashes as literal POSIX filename components",
    async () => {
      const root = await temporaryRoot();
      const ownedRoot = join(root, "owned");
      const literalDirectory = join(ownedRoot, "segment\\with-backslash");
      const literalFile = join(literalDirectory, "file\\with-backslash.txt");
      await ensurePrivateDirectory(ownedRoot);
      await ensurePrivateDirectory(literalDirectory, ownedRoot);
      await writeFile(literalFile, "literal backslashes\n");

      await expect(validatePrivatePath(ownedRoot, relative(ownedRoot, literalFile))).resolves.toBe(
        literalFile,
      );
      await expect(readPrivateFileBounded(literalFile, 20, ownedRoot)).resolves.toEqual(
        Buffer.from("literal backslashes\n"),
      );
      await hardenPrivateFile(literalFile, ownedRoot);

      await expect(access(join(ownedRoot, "segment", "with-backslash"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expectMode(literalDirectory, 0o700);
      await expectMode(literalFile, 0o600);
    },
  );

  it("creates fresh private directories and re-hardens existing ones", async () => {
    const root = await temporaryRoot();
    const freshParent = join(root, "fresh");
    const fresh = join(freshParent, "nested");
    const existing = join(root, "existing");
    const ownedRoot = join(root, ".graphcraft");
    const ownedParent = join(ownedRoot, "runs");
    const ownedExisting = join(ownedParent, "run-1");
    await mkdir(existing);
    await mkdir(ownedExisting, { recursive: true });

    if (process.platform !== "win32")
      await Promise.all([
        chmod(root, 0o755),
        chmod(existing, 0o755),
        chmod(ownedRoot, 0o755),
        chmod(ownedParent, 0o755),
        chmod(ownedExisting, 0o755),
      ]);
    await ensurePrivateDirectory(fresh);
    await ensurePrivateDirectory(existing);
    await ensurePrivateDirectory(ownedExisting, ownedRoot);

    expect((await lstat(fresh)).isDirectory()).toBe(true);
    expect((await lstat(existing)).isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      await expectMode(freshParent, 0o700);
      await expectMode(fresh, 0o700);
      await expectMode(existing, 0o700);
      await expectMode(root, 0o755);
      await expectMode(ownedRoot, 0o700);
      await expectMode(ownedParent, 0o700);
      await expectMode(ownedExisting, 0o700);
    }
  });

  it("hardens every directory and regular file in a nested tree", async () => {
    const root = await temporaryRoot();
    const tree = join(root, "tree");
    const nested = join(tree, "nested", "deep");
    const firstFile = join(tree, "first.txt");
    const secondFile = join(nested, "second.txt");
    await mkdir(nested, { recursive: true });
    await writeFile(firstFile, "first\n");
    await writeFile(secondFile, "second\n");

    if (process.platform !== "win32") {
      await Promise.all([
        chmod(tree, 0o755),
        chmod(join(tree, "nested"), 0o755),
        chmod(nested, 0o755),
        chmod(firstFile, 0o644),
        chmod(secondFile, 0o666),
      ]);
    }
    await hardenPrivateTree(tree);

    expect((await lstat(firstFile)).isFile()).toBe(true);
    expect((await lstat(secondFile)).isFile()).toBe(true);
    if (process.platform !== "win32") {
      await expectMode(tree, 0o700);
      await expectMode(join(tree, "nested"), 0o700);
      await expectMode(nested, 0o700);
      await expectMode(firstFile, 0o600);
      await expectMode(secondFile, 0o600);
    }
  });

  it.skipIf(process.platform !== "darwin")(
    "removes explicit and inherited macOS ACL entries from a private tree",
    async () => {
      const root = await temporaryRoot();
      const tree = join(root, "acl-tree");
      const explicitFile = join(tree, "explicit.txt");
      const inheritedFile = join(tree, "inherited.txt");
      await mkdir(tree);
      await writeFile(explicitFile, "explicit\n");
      await runDarwinTool("/bin/chmod", [
        "+a",
        "everyone allow list,search,readattr,readextattr,readsecurity,file_inherit,directory_inherit",
        tree,
      ]);
      await runDarwinTool("/bin/chmod", [
        "+a",
        "everyone allow read,readattr,readextattr,readsecurity",
        explicitFile,
      ]);
      await writeFile(inheritedFile, "inherited\n");

      for (const path of [tree, explicitFile, inheritedFile])
        expect(await darwinAclListing(path)).toMatch(/\n \d+:/);

      await hardenPrivateTree(tree);

      for (const path of [tree, explicitFile, inheritedFile])
        expect(await darwinAclListing(path)).not.toMatch(/\n \d+:/);
      await expectMode(tree, 0o700);
      await expectMode(explicitFile, 0o600);
      await expectMode(inheritedFile, 0o600);
    },
  );

  it("refuses symbolic links instead of following them", async () => {
    const root = await temporaryRoot();
    const tree = join(root, "tree");
    const target = join(root, "target");
    const targetFile = join(target, "outside.txt");
    await Promise.all([mkdir(tree), mkdir(target)]);
    await writeFile(targetFile, "outside\n");
    if (process.platform !== "win32") await chmod(targetFile, 0o644);
    await symlink(target, join(tree, "linked"), process.platform === "win32" ? "junction" : "dir");

    await expect(hardenPrivateTree(tree)).rejects.toThrow("Refusing to harden symbolic link");
    expect((await lstat(join(tree, "linked"))).isSymbolicLink()).toBe(true);
    if (process.platform !== "win32") await expectMode(targetFile, 0o644);
  });

  it("refuses a symlinked component beneath an explicitly owned root", async () => {
    const root = await temporaryRoot();
    const ownedRoot = join(root, ".graphcraft");
    const outside = join(root, "outside");
    await Promise.all([ensurePrivateDirectory(ownedRoot), mkdir(outside)]);
    if (process.platform !== "win32") await chmod(outside, 0o755);
    await symlink(
      outside,
      join(ownedRoot, "runs"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(validatePrivatePath(ownedRoot, "runs/run-1")).rejects.toThrow(
      "Refusing to harden symbolic link",
    );
    await expect(
      ensurePrivateDirectory(join(ownedRoot, "runs", "run-1"), ownedRoot),
    ).rejects.toThrow("Refusing to harden symbolic link");
    await expect(access(join(outside, "run-1"))).rejects.toMatchObject({ code: "ENOENT" });
    if (process.platform !== "win32") await expectMode(outside, 0o755);
  });

  it("refuses multiply linked files before changing the shared inode", async () => {
    const root = await temporaryRoot();
    const tree = join(root, "tree");
    const outside = join(root, "outside.txt");
    const linked = join(tree, "linked.txt");
    await ensurePrivateDirectory(tree);
    await writeFile(outside, "shared\n");
    if (process.platform !== "win32") await chmod(outside, 0o644);
    await link(outside, linked);

    await expect(hardenPrivateFile(linked, tree)).rejects.toThrow(
      "Refusing to harden multiply linked file",
    );
    await expect(hardenPrivateTree(tree)).rejects.toThrow(
      "Refusing to harden multiply linked file",
    );
    if (process.platform !== "win32") await expectMode(outside, 0o644);
  });

  it("hardens an existing file, ignores an absent file, and stays functional on Windows", async () => {
    const root = await temporaryRoot();
    const file = join(root, "private.json");
    await writeFile(file, "{}\n");
    if (process.platform !== "win32") await chmod(file, 0o666);
    else await grantWindowsEveryone(file);

    await hardenPrivateFile(file);
    await expect(hardenPrivateFile(join(root, "absent.json"))).resolves.toBeUndefined();

    expect((await lstat(file)).isFile()).toBe(true);
    if (process.platform !== "win32") await expectMode(file, 0o600);
    else await expectWindowsOwnerOnly(file);
  });

  it("serializes concurrent private JSON replacements without poisoning later writes", async () => {
    const root = await temporaryRoot();
    const ownedRoot = join(root, "concurrent private projections");
    const path = join(ownedRoot, "state.json");
    await ensurePrivateDirectory(ownedRoot);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(writePrivateJsonAtomic(path, cyclic, ownedRoot)).rejects.toThrow(
      "safe redaction depth",
    );

    for (let wave = 0; wave < 2; wave += 1) {
      await Promise.all(
        Array.from({ length: 32 }, (_, sequence) =>
          writePrivateJsonAtomic(path, { sequence: wave * 32 + sequence }, ownedRoot),
        ),
      );
      const persisted = JSON.parse(
        (await readPrivateFileBounded(path, 1024, ownedRoot)).toString("utf8"),
      ) as { sequence: number };
      expect(persisted.sequence).toBeGreaterThanOrEqual(wave * 32);
      expect(persisted.sequence).toBeLessThan((wave + 1) * 32);
    }

    if (process.platform !== "win32") await expectMode(path, 0o600);
    else await expectWindowsOwnerExclusive(path);
  });

  it("keeps strict publication identity by default but accepts a private projection supersession", async () => {
    const root = await temporaryRoot();
    const ownedRoot = join(root, "superseded private projections");
    await ensurePrivateDirectory(ownedRoot);
    const publishThenSupersede = async (path: string) => {
      const publication = await writeJsonAtomic(path, { writer: "original" });
      await writeJsonAtomic(path, { writer: "external" });
      return publication;
    };
    const strictPath = join(ownedRoot, "strict.json");

    await expect(
      publishPrivateFileAtomic({
        path: strictPath,
        ownedRoot,
        sourceDirectory: ownedRoot,
        hardenOnPosix: false,
        publish: async () => await publishThenSupersede(strictPath),
      }),
    ).rejects.toThrow("changed filesystem identity");
    expect(
      JSON.parse((await readPrivateFileBounded(strictPath, 1024, ownedRoot)).toString("utf8")),
    ).toEqual({ writer: "external" });

    const projectionPath = join(ownedRoot, "projection.json");
    await expect(
      publishPrivateFileAtomic({
        path: projectionPath,
        ownedRoot,
        sourceDirectory: ownedRoot,
        hardenOnPosix: false,
        supersessionPolicy: "reconstructable_projection",
        publish: async () => await publishThenSupersede(projectionPath),
      }),
    ).resolves.toBeUndefined();
    expect(
      JSON.parse((await readPrivateFileBounded(projectionPath, 1024, ownedRoot)).toString("utf8")),
    ).toEqual({ writer: "external" });

    if (process.platform !== "win32") {
      await expectMode(strictPath, 0o600);
      await expectMode(projectionPath, 0o600);
    } else {
      await expectWindowsOwnerExclusive(strictPath);
      await expectWindowsOwnerOnly(projectionPath);
    }
  });

  it.skipIf(process.platform !== "win32")(
    "removes inherited and explicit non-owner Windows access rules",
    async () => {
      const root = await temporaryRoot();
      const tree = join(root, "private tree Ω ' [x] & $()");
      const file = join(tree, "private file Ω ' [x] & $().json");
      await ensurePrivateDirectory(tree);
      await writeFile(file, "{}\n");
      await grantWindowsEveryone(file);

      await hardenPrivateTree(tree);

      for (const path of [tree, file]) await expectWindowsOwnerOnly(path);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "re-enforces cached Windows ACLs after same-object ACL drift",
    async () => {
      const root = await temporaryRoot();
      const directory = join(root, "cached directory");
      const file = join(directory, "cached file.json");
      await ensurePrivateDirectory(directory);
      await writeFile(file, "{}\n");
      await hardenPrivateFile(file, directory);

      await grantWindowsEveryone(directory);
      await grantWindowsEveryone(file);
      await writeFile(file, '{"changed":true}\n');
      await ensurePrivateDirectory(directory);
      await hardenPrivateFile(file, directory);

      for (const path of [directory, file]) await expectWindowsOwnerOnly(path);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "serializes concurrent owner-only hardening of the same Windows directory",
    async () => {
      const root = await temporaryRoot();
      const directory = join(root, "concurrent ACL target");
      await mkdir(directory);
      await grantWindowsEveryone(directory);

      await Promise.all(Array.from({ length: 16 }, () => ensurePrivateDirectory(directory)));

      await expectWindowsOwnerOnly(directory);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "advances the Windows ACL cache across a controlled child unlink",
    async () => {
      const root = await temporaryRoot();
      const directory = join(root, "directory mutation");
      const file = join(directory, "removed.txt");
      await ensurePrivateDirectory(directory);
      await writeFile(file, "removed\n");
      const mutation = await preparePrivateDirectoryMutation(directory);

      await unlink(file);
      await finalizePrivateDirectoryMutation(mutation);
      await ensurePrivateDirectory(directory);

      await expectWindowsOwnerOnly(directory);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "publishes concurrent JSON replacements under owner-exclusive inherited ACLs",
    async () => {
      const root = await temporaryRoot();
      const ownedRoot = join(root, "private projections");
      const path = join(ownedRoot, "state.json");
      await ensurePrivateDirectory(ownedRoot);
      await writePrivateJsonAtomic(path, { sequence: 0 }, ownedRoot);
      await expectWindowsOwnerExclusive(path);

      await grantWindowsEveryone(path);
      await Promise.all(
        Array.from({ length: 16 }, (_, sequence) =>
          writePrivateJsonAtomic(path, { sequence: sequence + 1 }, ownedRoot),
        ),
      );

      expect(
        JSON.parse((await readPrivateFileBounded(path, 1024, ownedRoot)).toString("utf8")),
      ).toMatchObject({ sequence: expect.any(Number) });
      await expectWindowsOwnerOnly(ownedRoot);
      await expectWindowsOwnerExclusive(path);
      await hardenPrivateFile(path, ownedRoot);
      await expectWindowsOwnerOnly(path);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "preserves descriptor publication identity across Windows atomic replacements",
    async () => {
      const root = await temporaryRoot();
      const ownedRoot = join(root, "descriptor publication identity");
      const path = join(ownedRoot, "state.json");
      await ensurePrivateDirectory(ownedRoot);

      for (const sequence of [1, 2]) {
        let publication: Awaited<ReturnType<typeof writeJsonAtomic>> | undefined;
        await publishPrivateFileAtomic({
          path,
          ownedRoot,
          sourceDirectory: ownedRoot,
          hardenOnPosix: false,
          publish: async () => {
            publication = await writeJsonAtomic(path, { sequence });
            return publication;
          },
        });
        if (publication === undefined) throw new Error("Expected an atomic publication receipt");
        const finalStatus = await lstat(path, { bigint: true });
        const receiptIdentity = privatePublicationIdentityFingerprint({
          dev: publication.device,
          ino: publication.inode,
          birthtimeNs: publication.birthtimeNs,
        });

        expect(receiptIdentity).toBeDefined();
        expect(privatePublicationIdentityFingerprint(finalStatus)).toBe(receiptIdentity);
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "publishes artifacts across verified Windows staging and target parents",
    async () => {
      const root = await temporaryRoot();
      const contract = compileRunContract(
        "Exercise Windows artifact ACL publication",
        { root, baseRef: "main", baseSha: "a".repeat(40) },
        { finishLine: "local_verified" },
      );
      const graph = compileGraph(contract, [
        { id: "verification-file", kind: "file", path: "verified.txt", shouldExist: true },
      ]);
      const store = await RunStore.create(root, contract, graph);
      const path = join(store.runRoot, "artifacts", "nested", "result.txt");

      await store.writeArtifact("nested/result.txt", "owner-exclusive artifact\n");

      await expectWindowsOwnerExclusive(path);
      await hardenPrivateFile(path, store.runRoot);
      await expectWindowsOwnerOnly(path);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "re-hardens the event log before an in-place append and safely advances its cache",
    async () => {
      const root = await temporaryRoot();
      const contract = compileRunContract(
        "Exercise Windows event-log ACL recovery",
        { root, baseRef: "main", baseSha: "a".repeat(40) },
        { finishLine: "local_verified" },
      );
      const graph = compileGraph(contract, [
        { id: "verification-file", kind: "file", path: "verified.txt", shouldExist: true },
      ]);
      const store = await RunStore.create(root, contract, graph);

      await grantWindowsEveryone(store.eventsPath());
      await store.append("runtime", "run.paused", { reason: "ACL recovery append" });
      await store.append("runtime", "run.started", { reason: "cached follow-up append" });

      await expectWindowsOwnerOnly(store.eventsPath());
    },
  );
});
