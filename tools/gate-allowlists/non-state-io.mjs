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
  {
    id: "environment-io.fd11f2cc7ba917bb",
    path: "packages/daemon/src/agent-declaration-migration.ts",
    category: "environment-io",
    subtype: "agent-declaration-migration",
    reason:
      "Writes an operator-requested candidate agent declaration file or asset directory before explicit agent installation; canonical agent state enters the ledger only on install. Signal: writeFileSync in migrateAgentDeclarations.",
    api: "writeFileSync",
    scope: "migrateAgentDeclarations",
  },
  {
    id: "environment-io.c856ef7e6562828b",
    path: "packages/daemon/src/agent-declaration-migration.ts",
    category: "environment-io",
    subtype: "agent-declaration-migration",
    reason:
      "Writes an operator-requested candidate agent declaration file or asset directory before explicit agent installation; canonical agent state enters the ledger only on install. Signal: mkdirSync in migrateAgentDeclarations.",
    api: "mkdirSync",
    scope: "migrateAgentDeclarations",
  },
  {
    id: "environment-io.b8e22ee9dc2cbdbb",
    path: "packages/daemon/src/agent-declaration-migration.ts",
    category: "environment-io",
    subtype: "agent-declaration-migration",
    reason:
      "Writes an operator-requested candidate agent declaration file or asset directory before explicit agent installation; canonical agent state enters the ledger only on install. Signal: writeFileSync in migrateAgentDeclarations.",
    api: "writeFileSync",
    scope: "migrateAgentDeclarations",
  },
  {
    id: "environment-io.11ea73f113a7658b",
    path: "packages/daemon/src/agent-runtime-instance-store.ts",
    category: "environment-io",
    subtype: "runtime-launch-scratch",
    reason:
      "Creates or reclaims per-session temporary launch/hook scratch directories under the runtime instance root; carries no persisted domain state. Signal: mkdirSync in finishLaunch.",
    api: "mkdirSync",
    scope: "finishLaunch",
  },
  {
    id: "environment-io.53e36032a7e7b1b3",
    path: "packages/daemon/src/agent-runtime-instance-store.ts",
    category: "environment-io",
    subtype: "runtime-launch-scratch",
    reason:
      "Creates or reclaims per-session temporary launch/hook scratch directories under the runtime instance root; carries no persisted domain state. Signal: rmSync in reclaimRuntimeTempDirectory.",
    api: "rmSync",
    scope: "reclaimRuntimeTempDirectory",
  },
  {
    id: "environment-io.c525f2977a64562a",
    path: "packages/daemon/src/client/daemon-autostart.ts",
    category: "environment-io",
    subtype: "daemon-os-service-unit",
    reason:
      "Manages host OS service supervisor unit files (launchd/systemd) or empty process spawn working directories; holds no application aggregate state. Signal: mkdirSync in writeDaemonServiceUnit.",
    api: "mkdirSync",
    scope: "writeDaemonServiceUnit",
  },
  {
    id: "environment-io.ebb0f3dc7d49ecf6",
    path: "packages/daemon/src/client/daemon-autostart.ts",
    category: "environment-io",
    subtype: "daemon-os-service-unit",
    reason:
      "Manages host OS service supervisor unit files (launchd/systemd) or empty process spawn working directories; holds no application aggregate state. Signal: mkdirSync in writeDaemonServiceUnit.",
    api: "mkdirSync",
    scope: "writeDaemonServiceUnit",
  },
  {
    id: "environment-io.d1ede72339cbae09",
    path: "packages/daemon/src/client/daemon-autostart.ts",
    category: "environment-io",
    subtype: "daemon-os-service-unit",
    reason:
      "Manages host OS service supervisor unit files (launchd/systemd) or empty process spawn working directories; holds no application aggregate state. Signal: writeFileSync in writeDaemonServiceUnit.",
    api: "writeFileSync",
    scope: "writeDaemonServiceUnit",
  },
  {
    id: "environment-io.a9c01bf05c0cfe26",
    path: "packages/daemon/src/client/daemon-autostart.ts",
    category: "environment-io",
    subtype: "daemon-os-service-unit",
    reason:
      "Manages host OS service supervisor unit files (launchd/systemd) or empty process spawn working directories; holds no application aggregate state. Signal: rmSync in removeDaemonServiceUnit.",
    api: "rmSync",
    scope: "removeDaemonServiceUnit",
  },
  {
    id: "environment-io.b44a95013e42368d",
    path: "packages/daemon/src/client/daemon-autostart.ts",
    category: "environment-io",
    subtype: "daemon-os-service-unit",
    reason:
      "Manages host OS service supervisor unit files (launchd/systemd) or empty process spawn working directories; holds no application aggregate state. Signal: mkdirSync in ensureDaemonSpawnRoot.",
    api: "mkdirSync",
    scope: "ensureDaemonSpawnRoot",
  },
  {
    id: "environment-io.5ac349285e591d4c",
    path: "packages/daemon/src/client/local-daemon-target.ts",
    category: "environment-io",
    subtype: "daemon-transport-socket",
    reason:
      "Creates the mode-0700 per-user temporary socket root directory for local IPC endpoints; stores no domain state. Signal: mkdirSync in mkdirSecurely.",
    api: "mkdirSync",
    scope: "mkdirSecurely",
  },
  {
    id: "environment-io.6d0e830b1d8e8184",
    path: "packages/daemon/src/conn-log.ts",
    category: "environment-io",
    subtype: "daemon-observability-log",
    reason:
      "Manages or reads size/age-rolled local daemon diagnostic, lifecycle, connection, probe, or request observability log files; accountability receipts live in the canonical ledger. Signal: mkdir in writeLine.",
    api: "mkdir",
    scope: "writeLine",
  },
  {
    id: "environment-io.322a27fbba962656",
    path: "packages/daemon/src/conn-log.ts",
    category: "environment-io",
    subtype: "daemon-observability-log",
    reason:
      "Manages or reads size/age-rolled local daemon diagnostic, lifecycle, connection, probe, or request observability log files; accountability receipts live in the canonical ledger. Signal: open in writeLine.",
    api: "open",
    scope: "writeLine",
  },
  {
    id: "environment-io.8c335c7d3f5a6f60",
    path: "packages/daemon/src/conn-log.ts",
    category: "environment-io",
    subtype: "daemon-observability-log",
    reason:
      "Manages or reads size/age-rolled local daemon diagnostic, lifecycle, connection, probe, or request observability log files; accountability receipts live in the canonical ledger. Signal: open in writeLine.",
    api: "open",
    scope: "writeLine",
  },
  {
    id: "environment-io.772a233589a799c0",
    path: "packages/daemon/src/conn-log.ts",
    category: "environment-io",
    subtype: "daemon-observability-log",
    reason:
      "Manages or reads size/age-rolled local daemon diagnostic, lifecycle, connection, probe, or request observability log files; accountability receipts live in the canonical ledger. Signal: rm in pruneOldDays.",
    api: "rm",
    scope: "pruneOldDays",
  },
  {
    id: "environment-io.119a357bb4245a64",
    path: "packages/daemon/src/conn-log.ts",
    category: "environment-io",
    subtype: "daemon-observability-log",
    reason:
      "Manages or reads size/age-rolled local daemon diagnostic, lifecycle, connection, probe, or request observability log files; accountability receipts live in the canonical ledger. Signal: rename in renameIfExists.",
    api: "rename",
    scope: "renameIfExists",
  },
  {
    id: "environment-io.ec7a202fd7b6fd10",
    path: "packages/daemon/src/lifecycle-log.ts",
    category: "environment-io",
    subtype: "daemon-observability-log",
    reason:
      "Manages or reads size/age-rolled local daemon diagnostic, lifecycle, connection, probe, or request observability log files; accountability receipts live in the canonical ledger. Signal: mkdirSync in openDaemonLifecycleLog.",
    api: "mkdirSync",
    scope: "openDaemonLifecycleLog",
  },
  {
    id: "environment-io.df81aef7aa74b913",
    path: "packages/daemon/src/lifecycle-log.ts",
    category: "environment-io",
    subtype: "daemon-observability-log",
    reason:
      "Manages or reads size/age-rolled local daemon diagnostic, lifecycle, connection, probe, or request observability log files; accountability receipts live in the canonical ledger. Signal: appendFileSync in openDaemonLifecycleLog.",
    api: "appendFileSync",
    scope: "openDaemonLifecycleLog",
  },
  {
    id: "environment-io.d0c312cacca07778",
    path: "packages/daemon/src/lifecycle-log.ts",
    category: "environment-io",
    subtype: "daemon-observability-log",
    reason:
      "Manages or reads size/age-rolled local daemon diagnostic, lifecycle, connection, probe, or request observability log files; accountability receipts live in the canonical ledger. Signal: mkdirSync in openDaemonOutputFd.",
    api: "mkdirSync",
    scope: "openDaemonOutputFd",
  },
  {
    id: "environment-io.435edbd8df19f65d",
    path: "packages/daemon/src/lifecycle-log.ts",
    category: "environment-io",
    subtype: "daemon-observability-log",
    reason:
      "Manages or reads size/age-rolled local daemon diagnostic, lifecycle, connection, probe, or request observability log files; accountability receipts live in the canonical ledger. Signal: openSync in openDaemonOutputFd.",
    api: "openSync",
    scope: "openDaemonOutputFd",
  },
  {
    id: "environment-io.3d928f21650aab9d",
    path: "packages/daemon/src/lifecycle-log.ts",
    category: "environment-io",
    subtype: "daemon-observability-log",
    reason:
      "Manages or reads size/age-rolled local daemon diagnostic, lifecycle, connection, probe, or request observability log files; accountability receipts live in the canonical ledger. Signal: closeSync in closeDaemonOutputFd.",
    api: "closeSync",
    scope: "closeDaemonOutputFd",
  },
  {
    id: "environment-io.2534a7ea79e2c8d2",
    path: "packages/daemon/src/lifecycle-log.ts",
    category: "environment-io",
    subtype: "daemon-observability-log",
    reason:
      "Manages or reads size/age-rolled local daemon diagnostic, lifecycle, connection, probe, or request observability log files; accountability receipts live in the canonical ledger. Signal: openSync in readDaemonLifecycleRecords.",
    api: "openSync",
    scope: "readDaemonLifecycleRecords",
  },
  {
    id: "environment-io.5a87f3c7e94203a3",
    path: "packages/daemon/src/lifecycle-log.ts",
    category: "environment-io",
    subtype: "daemon-observability-log",
    reason:
      "Manages or reads size/age-rolled local daemon diagnostic, lifecycle, connection, probe, or request observability log files; accountability receipts live in the canonical ledger. Signal: closeSync in readDaemonLifecycleRecords.",
    api: "closeSync",
    scope: "readDaemonLifecycleRecords",
  },
  {
    id: "environment-io.704983ddbd864c1d",
    path: "packages/daemon/src/lifecycle-log.ts",
    category: "environment-io",
    subtype: "daemon-observability-log",
    reason:
      "Manages or reads size/age-rolled local daemon diagnostic, lifecycle, connection, probe, or request observability log files; accountability receipts live in the canonical ledger. Signal: rmSync in rotateLifecycleLog.",
    api: "rmSync",
    scope: "rotateLifecycleLog",
  },
  {
    id: "environment-io.72b8d8e75f7f721b",
    path: "packages/daemon/src/lifecycle-log.ts",
    category: "environment-io",
    subtype: "daemon-observability-log",
    reason:
      "Manages or reads size/age-rolled local daemon diagnostic, lifecycle, connection, probe, or request observability log files; accountability receipts live in the canonical ledger. Signal: rmSync in rotateLifecycleLog.",
    api: "rmSync",
    scope: "rotateLifecycleLog",
  },
  {
    id: "environment-io.801d4a0fe4d0d9b8",
    path: "packages/daemon/src/lifecycle-log.ts",
    category: "environment-io",
    subtype: "daemon-observability-log",
    reason:
      "Manages or reads size/age-rolled local daemon diagnostic, lifecycle, connection, probe, or request observability log files; accountability receipts live in the canonical ledger. Signal: renameSync in rotateLifecycleLog.",
    api: "renameSync",
    scope: "rotateLifecycleLog",
  },
  {
    id: "environment-io.c079f11d542d95e6",
    path: "packages/daemon/src/lifecycle-log.ts",
    category: "environment-io",
    subtype: "daemon-observability-log",
    reason:
      "Manages or reads size/age-rolled local daemon diagnostic, lifecycle, connection, probe, or request observability log files; accountability receipts live in the canonical ledger. Signal: renameSync in rotateLifecycleLog.",
    api: "renameSync",
    scope: "rotateLifecycleLog",
  },
  {
    id: "environment-io.b62396679580c5a1",
    path: "packages/daemon/src/observe-jsonl-tail.ts",
    category: "environment-io",
    subtype: "daemon-observability-log",
    reason:
      "Manages or reads size/age-rolled local daemon diagnostic, lifecycle, connection, probe, or request observability log files; accountability receipts live in the canonical ledger. Signal: open in openStableFile.",
    api: "open",
    scope: "openStableFile",
  },
  {
    id: "environment-io.9be0f8fbd8c5f109",
    path: "packages/daemon/src/probe-log-sink.ts",
    category: "environment-io",
    subtype: "daemon-observability-log",
    reason:
      "Manages or reads size/age-rolled local daemon diagnostic, lifecycle, connection, probe, or request observability log files; accountability receipts live in the canonical ledger. Signal: mkdir in writeLine.",
    api: "mkdir",
    scope: "writeLine",
  },
  {
    id: "environment-io.f2d57822d6b3d560",
    path: "packages/daemon/src/probe-log-sink.ts",
    category: "environment-io",
    subtype: "daemon-observability-log",
    reason:
      "Manages or reads size/age-rolled local daemon diagnostic, lifecycle, connection, probe, or request observability log files; accountability receipts live in the canonical ledger. Signal: open in writeLine.",
    api: "open",
    scope: "writeLine",
  },
  {
    id: "environment-io.690433e47117a394",
    path: "packages/daemon/src/probe-log-sink.ts",
    category: "environment-io",
    subtype: "daemon-observability-log",
    reason:
      "Manages or reads size/age-rolled local daemon diagnostic, lifecycle, connection, probe, or request observability log files; accountability receipts live in the canonical ledger. Signal: mkdir in ensureProbeDirectory.",
    api: "mkdir",
    scope: "ensureProbeDirectory",
  },
  {
    id: "environment-io.b71e5d2d09de6e06",
    path: "packages/daemon/src/probe-log-sink.ts",
    category: "environment-io",
    subtype: "daemon-observability-log",
    reason:
      "Manages or reads size/age-rolled local daemon diagnostic, lifecycle, connection, probe, or request observability log files; accountability receipts live in the canonical ledger. Signal: writeFile in writeProbeFile.",
    api: "writeFile",
    scope: "writeProbeFile",
  },
  {
    id: "environment-io.3ed3a8e5f168e3da",
    path: "packages/daemon/src/probe-log-sink.ts",
    category: "environment-io",
    subtype: "daemon-observability-log",
    reason:
      "Manages or reads size/age-rolled local daemon diagnostic, lifecycle, connection, probe, or request observability log files; accountability receipts live in the canonical ledger. Signal: rm in pruneOldDays.",
    api: "rm",
    scope: "pruneOldDays",
  },
  {
    id: "environment-io.a4b2ae42a0d210f8",
    path: "packages/daemon/src/repo-cache-purge.ts",
    category: "environment-io",
    subtype: "repo-cache-cleanup",
    reason:
      "Deletes regenerable local cache directories or operator-retired repository Harness roots after backup verification; writes no domain state. Signal: rmSync in purgeRepoCache.",
    api: "rmSync",
    scope: "purgeRepoCache",
  },
  {
    id: "environment-io.9bc5b49b9a770b83",
    path: "packages/daemon/src/repo-cache-purge.ts",
    category: "environment-io",
    subtype: "repo-cache-cleanup",
    reason:
      "Deletes regenerable local cache directories or operator-retired repository Harness roots after backup verification; writes no domain state. Signal: rmSync in removeRepoHarnessRoots.",
    api: "rmSync",
    scope: "removeRepoHarnessRoots",
  },
  {
    id: "environment-io.3dd8b1ca6b76b91c",
    path: "packages/daemon/src/request-log.ts",
    category: "environment-io",
    subtype: "daemon-observability-log",
    reason:
      "Manages or reads size/age-rolled local daemon diagnostic, lifecycle, connection, probe, or request observability log files; accountability receipts live in the canonical ledger. Signal: mkdir in openSink.",
    api: "mkdir",
    scope: "openSink",
  },
  {
    id: "environment-io.69b1169ea4d01ff3",
    path: "packages/daemon/src/request-log.ts",
    category: "environment-io",
    subtype: "daemon-observability-log",
    reason:
      "Manages or reads size/age-rolled local daemon diagnostic, lifecycle, connection, probe, or request observability log files; accountability receipts live in the canonical ledger. Signal: rm in pruneAgedFiles.",
    api: "rm",
    scope: "pruneAgedFiles",
  },
  {
    id: "environment-io.b99cb7e864440348",
    path: "packages/daemon/src/request-log.ts",
    category: "environment-io",
    subtype: "daemon-observability-log",
    reason:
      "Manages or reads size/age-rolled local daemon diagnostic, lifecycle, connection, probe, or request observability log files; accountability receipts live in the canonical ledger. Signal: rename in renameIfExists.",
    api: "rename",
    scope: "renameIfExists",
  },
  {
    id: "environment-io.f7701295bb5a8c9f",
    path: "packages/daemon/src/runtime-callback-relay.ts",
    category: "environment-io",
    subtype: "daemon-transport-socket",
    reason:
      "Unlinks stale or closing UNIX domain IPC/relay socket inodes around transport server lifecycle; stores no domain state. Signal: rmSync in removeRuntimeCallbackRelay.",
    api: "rmSync",
    scope: "removeRuntimeCallbackRelay",
  },
  {
    id: "environment-io.251625d620743e95",
    path: "packages/daemon/src/runtime-callback-relay.ts",
    category: "environment-io",
    subtype: "daemon-transport-socket",
    reason:
      "Unlinks stale or closing UNIX domain IPC/relay socket inodes around transport server lifecycle; stores no domain state. Signal: unlinkSync in removeStaleRelay.",
    api: "unlinkSync",
    scope: "removeStaleRelay",
  },
  {
    id: "environment-io.def6ae045029d530",
    path: "packages/daemon/src/skill-eval-runner.ts",
    category: "environment-io",
    subtype: "skill-eval-sandbox",
    reason:
      "Creates an isolated per-case temporary working directory for a skill evaluation runtime invocation; stores no catalog or evaluation state. Signal: mkdir in sandboxDirectory.",
    api: "mkdir",
    scope: "sandboxDirectory",
  },
  {
    id: "environment-io.1933a00ec3702ddb",
    path: "packages/daemon/src/task-worktree.ts",
    category: "environment-io",
    subtype: "worktree-setup",
    reason:
      "Creates the parent directory under .worktrees/.review before detached git worktree checkout for immutable review inspection; derived from canonical commit SHA. Signal: mkdirSync in addPinnedReviewWorktree.",
    api: "mkdirSync",
    scope: "addPinnedReviewWorktree",
  },
  {
    id: "environment-io.e0963dd729d80e07",
    path: "packages/daemon/src/transport/unix-socket.ts",
    category: "environment-io",
    subtype: "daemon-transport-socket",
    reason:
      "Unlinks stale or closing UNIX domain IPC/relay socket inodes around transport server lifecycle; stores no domain state. Signal: rmSync in createUnixSocketTransportServer.",
    api: "rmSync",
    scope: "createUnixSocketTransportServer",
  },
  {
    id: "environment-io.961cdcaa9a92cbbe",
    path: "packages/daemon/src/transport/unix-socket.ts",
    category: "environment-io",
    subtype: "daemon-transport-socket",
    reason:
      "Unlinks stale or closing UNIX domain IPC/relay socket inodes around transport server lifecycle; stores no domain state. Signal: rmSync in createUnixSocketTransportServer.",
    api: "rmSync",
    scope: "createUnixSocketTransportServer",
  },
]);
