// Explicit non-business environment I/O. Each declaration binds one source site, API and reason.
export const NON_STATE_IO_CATEGORY = "environment-io";
export const nonStateIoDeclarations = Object.freeze([
  {
    id: "environment-io.773f1f24462e0efd",
    path: "packages/authorization-keycloak/src/managed-rbac-listener-certificate.ts",
    category: "environment-io",
    subtype: "certificate-material",
    reason:
      "This self-signed certificate/key is generated from configured host and address names and recreated with listener setup; it does not record business workflow state. Signal: rmSync in ensureSelfSignedCertificate.",
    api: "rmSync",
    scope: "ensureSelfSignedCertificate",
  },
  {
    id: "environment-io.44f16540c48fcc72",
    path: "packages/authorization-keycloak/src/managed-rbac-listener-certificate.ts",
    category: "environment-io",
    subtype: "certificate-material",
    reason:
      "This self-signed certificate/key is generated from configured host and address names and recreated with listener setup; it does not record business workflow state. Signal: rmSync in ensureSelfSignedCertificate.",
    api: "rmSync",
    scope: "ensureSelfSignedCertificate",
  },
  {
    id: "environment-io.580e80f3650a0879",
    path: "packages/authorization-keycloak/src/managed-rbac-listener-certificate.ts",
    category: "environment-io",
    subtype: "certificate-material",
    reason:
      "This self-signed certificate/key is generated from configured host and address names and recreated with listener setup; it does not record business workflow state. Signal: mkdirSync in ensureSelfSignedCertificate.",
    api: "mkdirSync",
    scope: "ensureSelfSignedCertificate",
  },
  {
    id: "environment-io.778729626dd1b40c",
    path: "packages/authorization-keycloak/src/managed-rbac-listener-certificate.ts",
    category: "environment-io",
    subtype: "certificate-material",
    reason:
      "This self-signed certificate/key is generated from configured host and address names and recreated with listener setup; it does not record business workflow state. Signal: rmSync in ensureSelfSignedCertificate.",
    api: "rmSync",
    scope: "ensureSelfSignedCertificate",
  },
  {
    id: "environment-io.8f59e38af283edd1",
    path: "packages/authorization-keycloak/src/managed-rbac-listener-certificate.ts",
    category: "environment-io",
    subtype: "certificate-material",
    reason:
      "This self-signed certificate/key is generated from configured host and address names and recreated with listener setup; it does not record business workflow state. Signal: rmSync in ensureSelfSignedCertificate.",
    api: "rmSync",
    scope: "ensureSelfSignedCertificate",
  },
  {
    id: "environment-io.0437be7bf65098b0",
    path: "packages/authorization-keycloak/src/managed-rbac-listener-certificate.ts",
    category: "environment-io",
    subtype: "certificate-material",
    reason:
      "This self-signed certificate/key is generated from configured host and address names and recreated with listener setup; it does not record business workflow state. Signal: rmSync in removeSelfSignedCertificate.",
    api: "rmSync",
    scope: "removeSelfSignedCertificate",
  },
  {
    id: "environment-io.64dd2033f7d1c003",
    path: "packages/authorization-keycloak/src/managed-rbac-listener-certificate.ts",
    category: "environment-io",
    subtype: "certificate-material",
    reason:
      "This self-signed certificate/key is generated from configured host and address names and recreated with listener setup; it does not record business workflow state. Signal: rmSync in removeSelfSignedCertificate.",
    api: "rmSync",
    scope: "removeSelfSignedCertificate",
  },
  {
    id: "environment-io.ee9a148662221fb5",
    path: "packages/authorization-keycloak/src/managed-rbac-service.ts",
    category: "environment-io",
    subtype: "keycloak-installation",
    reason:
      "Installs or maintains managed Keycloak/PostgreSQL runtime binaries, database environment, authentication configuration, or process logs; no application aggregate record is written.",
    api: "mkdirSync",
    scope: "ensurePostgresBinaries",
  },
  {
    id: "environment-io.3095f85298fdb651",
    path: "packages/authorization-keycloak/src/managed-rbac-service.ts",
    category: "environment-io",
    subtype: "keycloak-installation",
    reason:
      "Installs or maintains managed Keycloak/PostgreSQL runtime binaries, database environment, authentication configuration, or process logs; no application aggregate record is written.",
    api: "mkdirSync",
    scope: "#install",
  },
  {
    id: "environment-io.239ff21497907099",
    path: "packages/authorization-keycloak/src/managed-rbac-service.ts",
    category: "environment-io",
    subtype: "keycloak-installation",
    reason:
      "Installs or maintains managed Keycloak/PostgreSQL runtime binaries, database environment, authentication configuration, or process logs; no application aggregate record is written.",
    api: "mkdirSync",
    scope: "#installArtifact",
  },
  {
    id: "environment-io.9c7724b3aea98a89",
    path: "packages/authorization-keycloak/src/managed-rbac-service.ts",
    category: "environment-io",
    subtype: "keycloak-installation",
    reason:
      "Installs or maintains managed Keycloak/PostgreSQL runtime binaries, database environment, authentication configuration, or process logs; no application aggregate record is written.",
    api: "createWriteStream",
    scope: "#installArtifact",
  },
  {
    id: "environment-io.eb62b26beba48b5c",
    path: "packages/authorization-keycloak/src/managed-rbac-service.ts",
    category: "environment-io",
    subtype: "keycloak-installation",
    reason:
      "Installs or maintains managed Keycloak/PostgreSQL runtime binaries, database environment, authentication configuration, or process logs; no application aggregate record is written.",
    api: "rmSync",
    scope: "#installArtifact",
  },
  {
    id: "environment-io.ee605250dd16e9ce",
    path: "packages/authorization-keycloak/src/managed-rbac-service.ts",
    category: "environment-io",
    subtype: "keycloak-installation",
    reason:
      "Installs or maintains managed Keycloak/PostgreSQL runtime binaries, database environment, authentication configuration, or process logs; no application aggregate record is written.",
    api: "renameSync",
    scope: "#installArtifact",
  },
  {
    id: "environment-io.7d512e09128ade68",
    path: "packages/authorization-keycloak/src/managed-rbac-service.ts",
    category: "environment-io",
    subtype: "keycloak-installation",
    reason:
      "Installs or maintains managed Keycloak/PostgreSQL runtime binaries, database environment, authentication configuration, or process logs; no application aggregate record is written.",
    api: "rmSync",
    scope: "#installArtifact",
  },
  {
    id: "environment-io.ab94576188dc15d2",
    path: "packages/authorization-keycloak/src/managed-rbac-service.ts",
    category: "environment-io",
    subtype: "keycloak-installation",
    reason:
      "Installs or maintains managed Keycloak/PostgreSQL runtime binaries, database environment, authentication configuration, or process logs; no application aggregate record is written.",
    api: "mkdirSync",
    scope: "#installArtifact",
  },
  {
    id: "environment-io.333e4cba839e4439",
    path: "packages/authorization-keycloak/src/managed-rbac-service.ts",
    category: "environment-io",
    subtype: "keycloak-installation",
    reason:
      "Installs or maintains managed Keycloak/PostgreSQL runtime binaries, database environment, authentication configuration, or process logs; no application aggregate record is written.",
    api: "writeFileSync",
    scope: "#installArtifact",
  },
  {
    id: "environment-io.065df41e6759b402",
    path: "packages/authorization-keycloak/src/managed-rbac-service.ts",
    category: "environment-io",
    subtype: "keycloak-installation",
    reason:
      "Installs or maintains managed Keycloak/PostgreSQL runtime binaries, database environment, authentication configuration, or process logs; no application aggregate record is written.",
    api: "mkdirSync",
    scope: "#initializeDatabase",
  },
  {
    id: "environment-io.a4045c59c63fc3a2",
    path: "packages/authorization-keycloak/src/managed-rbac-service.ts",
    category: "environment-io",
    subtype: "keycloak-installation",
    reason:
      "Installs or maintains managed Keycloak/PostgreSQL runtime binaries, database environment, authentication configuration, or process logs; no application aggregate record is written.",
    api: "mkdirSync",
    scope: "#startPostgres",
  },
  {
    id: "environment-io.7e05d05bacdd5d95",
    path: "packages/authorization-keycloak/src/managed-rbac-service.ts",
    category: "environment-io",
    subtype: "keycloak-installation",
    reason:
      "Installs or maintains managed Keycloak/PostgreSQL runtime binaries, database environment, authentication configuration, or process logs; no application aggregate record is written.",
    api: "writeFileSync",
    scope: "#hardenPostgresAuthentication",
  },
  {
    id: "environment-io.17c06ba5fde6715a",
    path: "packages/authorization-keycloak/src/managed-rbac-service.ts",
    category: "environment-io",
    subtype: "keycloak-installation",
    reason:
      "Installs or maintains managed Keycloak/PostgreSQL runtime binaries, database environment, authentication configuration, or process logs; no application aggregate record is written.",
    api: "mkdirSync",
    scope: "#spawnUntilReady",
  },
  {
    id: "environment-io.22a7d1ac88b4e2e2",
    path: "packages/authorization-keycloak/src/managed-rbac-service.ts",
    category: "environment-io",
    subtype: "keycloak-installation",
    reason:
      "Installs or maintains managed Keycloak/PostgreSQL runtime binaries, database environment, authentication configuration, or process logs; no application aggregate record is written.",
    api: "createWriteStream",
    scope: "log",
  },
  {
    id: "environment-io.4686678adb8578e2",
    path: "packages/authorization-keycloak/src/managed-rbac-service.ts",
    category: "environment-io",
    subtype: "keycloak-installation",
    reason:
      "Installs or maintains managed Keycloak/PostgreSQL runtime binaries, database environment, authentication configuration, or process logs; no application aggregate record is written.",
    api: "openSync",
    scope: "log",
  },
  {
    id: "environment-io.5af6638f0933b9a3",
    path: "packages/authorization-keycloak/src/managed-rbac-service.ts",
    category: "environment-io",
    subtype: "keycloak-installation",
    reason:
      "Installs or maintains managed Keycloak/PostgreSQL runtime binaries, database environment, authentication configuration, or process logs; no application aggregate record is written.",
    api: "mkdirSync",
    scope: "extractArtifact",
  },
  {
    id: "environment-io.3a20b668c42be8a5",
    path: "packages/authorization-keycloak/src/managed-rbac-service.ts",
    category: "environment-io",
    subtype: "keycloak-installation",
    reason:
      "Installs or maintains managed Keycloak/PostgreSQL runtime binaries, database environment, authentication configuration, or process logs; no application aggregate record is written.",
    api: "rmSync",
    scope: "extractArtifact",
  },
  {
    id: "environment-io.0093cea5d2acccb9",
    path: "packages/authorization-keycloak/src/managed-rbac-service.ts",
    category: "environment-io",
    subtype: "keycloak-installation",
    reason:
      "Installs or maintains managed Keycloak/PostgreSQL runtime binaries, database environment, authentication configuration, or process logs; no application aggregate record is written.",
    api: "renameSync",
    scope: "flattenSingleDirectory",
  },
  {
    id: "environment-io.020223a0282a302d",
    path: "packages/authorization-keycloak/src/managed-rbac-service.ts",
    category: "environment-io",
    subtype: "keycloak-installation",
    reason:
      "Installs or maintains managed Keycloak/PostgreSQL runtime binaries, database environment, authentication configuration, or process logs; no application aggregate record is written.",
    api: "rmSync",
    scope: "flattenSingleDirectory",
  },
  {
    id: "environment-io.9538dcd0559cba9f",
    path: "packages/daemon/src/worktree-node-modules-mirror.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: mkdirSync in mirrorStore.",
    api: "mkdirSync",
    scope: "mirrorStore",
  },
  {
    id: "environment-io.03922c1e35489b17",
    path: "packages/daemon/src/worktree-node-modules-mirror.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: copyFileSync in mirrorStore.",
    api: "copyFileSync",
    scope: "mirrorStore",
  },
  {
    id: "environment-io.25160125d6541765",
    path: "packages/daemon/src/worktree-node-modules-mirror.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: symlinkSync in mirrorStore.",
    api: "symlinkSync",
    scope: "mirrorStore",
  },
  {
    id: "environment-io.3711cd9bed7ee691",
    path: "packages/daemon/src/worktree-setup-node-modules.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: rmSync in prepare.",
    api: "rmSync",
    scope: "prepare",
  },
  {
    id: "environment-io.53361524924e14cc",
    path: "packages/daemon/src/schedule-occurrence-workspace.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This empty leftover directory carries no .git marker and no entries, so it records no business workflow state; worktree setup recreates it. Signal: rmdirSync in reclaimManagedWorktree.",
    api: "rmdirSync",
    scope: "reclaimManagedWorktree",
  },
  {
    id: "environment-io.62027d9c14966472",
    path: "packages/daemon/src/worktree-setup-node-modules.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: rmSync in cleanup.",
    api: "rmSync",
    scope: "cleanup",
  },
  {
    id: "environment-io.47892a4a432ad79a",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: mkdirSync in runWorktreeSetup.",
    api: "mkdirSync",
    scope: "runWorktreeSetup",
  },
  {
    id: "environment-io.e978a15f3b2fb103",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: writeFileSync in runWorktreeSetup.",
    api: "writeFileSync",
    scope: "runWorktreeSetup",
  },
  {
    id: "environment-io.584239915a9d403f",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: writeFileSync in runWorktreeSetup.",
    api: "writeFileSync",
    scope: "runWorktreeSetup",
  },
  {
    id: "environment-io.4a19b77cc94f5648",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: writeFileSync in cleanupWorktreeSetup.",
    api: "writeFileSync",
    scope: "cleanupWorktreeSetup",
  },
  {
    id: "environment-io.2b5cb73c19477a59",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: appendFileSync in runStep.",
    api: "appendFileSync",
    scope: "runStep",
  },
  {
    id: "environment-io.b5a72e6a2315c1b2",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: rmdirSync in clearWorktreeLedgerMirror.",
    api: "rmdirSync",
    scope: "clearWorktreeLedgerMirror",
  },
  {
    id: "environment-io.5d1712f8bfbde7e1",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: unlinkSync in removeMirrorEntry.",
    api: "unlinkSync",
    scope: "removeMirrorEntry",
  },
  {
    id: "environment-io.59efa489be0f2990",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: rmdirSync in removeMirrorEntry.",
    api: "rmdirSync",
    scope: "removeMirrorEntry",
  },
  {
    id: "environment-io.97ebea1bc7f7c550",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: mkdirSync in linkWorktreeLedger.",
    api: "mkdirSync",
    scope: "linkWorktreeLedger",
  },
  {
    id: "environment-io.070db42aa4c12fe4",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: unlinkSync in linkWorktreeLedger.",
    api: "unlinkSync",
    scope: "linkWorktreeLedger",
  },
  {
    id: "environment-io.4cb63039a2e685dc",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: unlinkSync in linkWorktreeLedger.",
    api: "unlinkSync",
    scope: "linkWorktreeLedger",
  },
  {
    id: "environment-io.90ea695e1d940212",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: unlinkSync in linkWorktreeLedger.",
    api: "unlinkSync",
    scope: "linkWorktreeLedger",
  },
  {
    id: "environment-io.32e3e08fe711f7bb",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: mkdirSync in linkWorktreeLedger.",
    api: "mkdirSync",
    scope: "linkWorktreeLedger",
  },
  {
    id: "environment-io.94a0cdf651772a78",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: mkdirSync in linkWorktreeLedger.",
    api: "mkdirSync",
    scope: "linkWorktreeLedger",
  },
  {
    id: "environment-io.86a0c8743f85091d",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: writeFileSync in linkWorktreeLedger.",
    api: "writeFileSync",
    scope: "linkWorktreeLedger",
  },
  {
    id: "environment-io.0b23760b01d9faf7",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: unlinkSync in linkWorktreeLedger.",
    api: "unlinkSync",
    scope: "linkWorktreeLedger",
  },
  {
    id: "environment-io.0deb3794b723e626",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: mkdirSync in writeTaskWorktreeDocumentBase.",
    api: "mkdirSync",
    scope: "writeTaskWorktreeDocumentBase",
  },
  {
    id: "environment-io.c26b78d6a3c9c571",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: writeFileSync in writeTaskWorktreeDocumentBase.",
    api: "writeFileSync",
    scope: "writeTaskWorktreeDocumentBase",
  },
  {
    id: "environment-io.64ae4c5d949e6e57",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: mkdirSync in mirrorTaskPackage.",
    api: "mkdirSync",
    scope: "mirrorTaskPackage",
  },
  {
    id: "environment-io.39e7f63feca22f4f",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: mkdirSync in mirrorTaskPackage.",
    api: "mkdirSync",
    scope: "mirrorTaskPackage",
  },
  {
    id: "environment-io.cdd8a29626dba774",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: copyFileSync in mirrorTaskPackage.",
    api: "copyFileSync",
    scope: "mirrorTaskPackage",
  },
  {
    id: "environment-io.d35718de7079bbb5",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: copyFileSync in mirrorTaskPackage.",
    api: "copyFileSync",
    scope: "mirrorTaskPackage",
  },
  {
    id: "environment-io.37e2f4e58b6b045d",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: copyFileSync in detachTaskDocument.",
    api: "copyFileSync",
    scope: "detachTaskDocument",
  },
  {
    id: "environment-io.1d0d7b2ca61bb7d2",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: renameSync in detachTaskDocument.",
    api: "renameSync",
    scope: "detachTaskDocument",
  },
  {
    id: "environment-io.28f0d0f15b149005",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: unlinkSync in unlinkWorktreeLedger.",
    api: "unlinkSync",
    scope: "unlinkWorktreeLedger",
  },
  {
    id: "environment-io.59a759d505c4aadf",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: unlinkSync in unlinkWorktreeLedger.",
    api: "unlinkSync",
    scope: "unlinkWorktreeLedger",
  },
  {
    id: "environment-io.d52ac26bd8aaf8af",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: unlinkSync in unlinkWorktreeLedger.",
    api: "unlinkSync",
    scope: "unlinkWorktreeLedger",
  },
  {
    id: "environment-io.bf29896710455de4",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: unlinkSync in ensureRealDirectory.",
    api: "unlinkSync",
    scope: "ensureRealDirectory",
  },
  {
    id: "environment-io.6cf4bce8ce3dccff",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: mkdirSync in ensureRealDirectory.",
    api: "mkdirSync",
    scope: "ensureRealDirectory",
  },
  {
    id: "environment-io.773a231762e8009f",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: copyFileSync in copyWorkerLedgerEntry.",
    api: "copyFileSync",
    scope: "copyWorkerLedgerEntry",
  },
  {
    id: "environment-io.1c6d593aa5ab22e5",
    path: "packages/daemon/src/worktree-setup.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "This worktree setup log, link, or mirror is derived from canonical repository/task data and recreated or discarded with the worktree. Signal: mkdirSync in copyWorkerLedgerEntry.",
    api: "mkdirSync",
    scope: "copyWorkerLedgerEntry",
  },
  {
    id: "environment-io.fac1fb306f76a3fd",
    path: "packages/gui/src/main/desktop-first-run.ts",
    category: "environment-io",
    subtype: "gui-first-run",
    reason:
      "This first-run shim or shell-path file configures the local desktop environment and is regenerated from the installed application. Signal: mkdirSync in ensureShim.",
    api: "mkdirSync",
    scope: "ensureShim",
  },
  {
    id: "environment-io.6aece9d6fb0ea444",
    path: "packages/gui/src/main/desktop-first-run.ts",
    category: "environment-io",
    subtype: "gui-first-run",
    reason:
      "This first-run shim or shell-path file configures the local desktop environment and is regenerated from the installed application. Signal: writeFileSync in ensureShim.",
    api: "writeFileSync",
    scope: "ensureShim",
  },
  {
    id: "environment-io.2d9dce2acd68696d",
    path: "packages/gui/src/main/desktop-first-run.ts",
    category: "environment-io",
    subtype: "gui-first-run",
    reason:
      "This first-run shim or shell-path file configures the local desktop environment and is regenerated from the installed application. Signal: mkdirSync in ensureShellPath.",
    api: "mkdirSync",
    scope: "ensureShellPath",
  },
  {
    id: "environment-io.6b766bd717472402",
    path: "packages/gui/src/main/desktop-first-run.ts",
    category: "environment-io",
    subtype: "gui-first-run",
    reason:
      "This first-run shim or shell-path file configures the local desktop environment and is regenerated from the installed application. Signal: writeFileSync in ensureShellPath.",
    api: "writeFileSync",
    scope: "ensureShellPath",
  },
  {
    id: "environment-io.90e64fd91491890f",
    path: "packages/preset/src/preset-installation.ts",
    category: "environment-io",
    subtype: "preset-installation",
    reason:
      "This file is a local installed copy or marker derived from declared preset package assets, not authored domain state. Signal: cpSync in installPresetPackage.",
    api: "cpSync",
    scope: "installPresetPackage",
  },
  {
    id: "environment-io.8e0cdc9fad22dfd7",
    path: "packages/preset/src/preset-installation.ts",
    category: "environment-io",
    subtype: "preset-installation",
    reason:
      "This file is a local installed copy or marker derived from declared preset package assets, not authored domain state. Signal: renameSync in installPresetPackage.",
    api: "renameSync",
    scope: "installPresetPackage",
  },
  {
    id: "environment-io.e76cc02569fd3980",
    path: "packages/preset/src/preset-installation.ts",
    category: "environment-io",
    subtype: "preset-installation",
    reason:
      "This file is a local installed copy or marker derived from declared preset package assets, not authored domain state. Signal: writeFileSync in installPresetPackage.",
    api: "writeFileSync",
    scope: "installPresetPackage",
  },
  {
    id: "environment-io.408fe75f302986af",
    path: "packages/preset/src/preset-installation.ts",
    category: "environment-io",
    subtype: "preset-installation",
    reason:
      "This file is a local installed copy or marker derived from declared preset package assets, not authored domain state. Signal: renameSync in installPresetPackage.",
    api: "renameSync",
    scope: "installPresetPackage",
  },
  {
    id: "environment-io.dd561f6c82e6f10e",
    path: "packages/preset/src/preset-installation.ts",
    category: "environment-io",
    subtype: "preset-installation",
    reason:
      "This file is a local installed copy or marker derived from declared preset package assets, not authored domain state. Signal: rmSync in installPresetPackage.",
    api: "rmSync",
    scope: "installPresetPackage",
  },
  {
    id: "environment-io.017bddb81521c53d",
    path: "packages/preset/src/preset-installation.ts",
    category: "environment-io",
    subtype: "preset-installation",
    reason:
      "This file is a local installed copy or marker derived from declared preset package assets, not authored domain state. Signal: rmSync in installPresetPackage.",
    api: "rmSync",
    scope: "installPresetPackage",
  },
  {
    id: "environment-io.b5dd9e6d69b88683",
    path: "packages/preset/src/preset-installation.ts",
    category: "environment-io",
    subtype: "preset-installation",
    reason:
      "This file is a local installed copy or marker derived from declared preset package assets, not authored domain state. Signal: unlinkSync in uninstallPresetPackage.",
    api: "unlinkSync",
    scope: "uninstallPresetPackage",
  },
  {
    id: "environment-io.56ea5455f4ad3d2a",
    path: "packages/preset/src/preset-installation.ts",
    category: "environment-io",
    subtype: "preset-installation",
    reason:
      "This file is a local installed copy or marker derived from declared preset package assets, not authored domain state. Signal: mkdirSync in ensureInstallDirectory.",
    api: "mkdirSync",
    scope: "ensureInstallDirectory",
  },
  {
    id: "environment-io.f88d088af75b8e1b",
    path: "packages/preset/src/preset-installation.ts",
    category: "environment-io",
    subtype: "preset-installation",
    reason:
      "This file is a local installed copy or marker derived from declared preset package assets, not authored domain state. Signal: writeFileSync in migrateCompletion.",
    api: "writeFileSync",
    scope: "migrateCompletion",
  },
  {
    id: "environment-io.8130d1b0a27b8121",
    path: "packages/preset/src/preset-installation.ts",
    category: "environment-io",
    subtype: "preset-installation",
    reason:
      "This file is a local installed copy or marker derived from declared preset package assets, not authored domain state. Signal: cpSync in migrateCompletion.",
    api: "cpSync",
    scope: "migrateCompletion",
  },
  {
    id: "environment-io.e2730ed8f06aaa6e",
    path: "packages/preset/src/preset-installation.ts",
    category: "environment-io",
    subtype: "preset-installation",
    reason:
      "This file is a local installed copy or marker derived from declared preset package assets, not authored domain state. Signal: writeFileSync in migrateCompletion.",
    api: "writeFileSync",
    scope: "migrateCompletion",
  },
  {
    id: "environment-io.43f6197ccf76a6f7",
    path: "packages/preset/src/preset-installation.ts",
    category: "environment-io",
    subtype: "preset-installation",
    reason:
      "This file is a local installed copy or marker derived from declared preset package assets, not authored domain state. Signal: cpSync in migrateCompletion.",
    api: "cpSync",
    scope: "migrateCompletion",
  },
  {
    id: "environment-io.a999b0d2bd36e3e4",
    path: "packages/preset/src/preset-installation.ts",
    category: "environment-io",
    subtype: "preset-installation",
    reason:
      "This file is a local installed copy or marker derived from declared preset package assets, not authored domain state. Signal: rmSync in migrateCompletion.",
    api: "rmSync",
    scope: "migrateCompletion",
  },
]);
