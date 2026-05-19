export type VmPowerState = "online" | "offline" | "transitioning" | "unknown";

export type VmAction = "start" | "stop" | "reboot" | "force-stop";

export type OperationType = "snapshot" | "backup" | "restore" | "cleanup" | "restore-recovery";

export interface KubeMetadata {
  name?: string;
  namespace?: string;
  uid?: string;
  creationTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface KubeCondition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export interface KubeObjectList<T> {
  items?: T[];
}

export interface KubeVirtVirtualMachine {
  apiVersion?: string;
  kind?: string;
  metadata?: KubeMetadata;
  spec?: {
    running?: boolean;
    runStrategy?: string;
    template?: {
      spec?: {
        domain?: {
          devices?: {
            interfaces?: Array<{ name?: string; masquerade?: unknown; bridge?: unknown }>;
          };
        };
        volumes?: Array<{
          name?: string;
          persistentVolumeClaim?: {
            claimName?: string;
          };
        }>;
      };
    };
  };
  status?: {
    created?: boolean;
    ready?: boolean;
    printableStatus?: string;
    runStrategy?: string;
    nodeName?: string;
    conditions?: KubeCondition[];
    volumeSnapshotStatuses?: Array<{
      name?: string;
      enabled?: boolean;
      reason?: string;
    }>;
  };
}

export interface KubeVirtVirtualMachineInstance {
  metadata?: KubeMetadata;
  status?: {
    nodeName?: string;
    phase?: string;
    conditions?: KubeCondition[];
    volumeStatus?: Array<{
      name?: string;
      persistentVolumeClaimInfo?: {
        claimName?: string;
      };
    }>;
    interfaces?: Array<{
      name?: string;
      ipAddress?: string;
      ipAddresses?: string[];
    }>;
  };
}

export interface KubeVirtVirtualMachineSnapshot {
  metadata?: KubeMetadata;
  spec?: {
    source?: {
      apiGroup?: string;
      kind?: string;
      name?: string;
    };
  };
  status?: {
    readyToUse?: boolean;
    phase?: string;
    creationTime?: string;
    error?: {
      message?: string;
      reason?: string;
    };
    conditions?: KubeCondition[];
    indications?: string[];
  };
}

export interface KubeVirtVirtualMachineSnapshotContent {
  metadata?: KubeMetadata;
  spec?: {
    virtualMachineSnapshotName?: string;
    volumeBackups?: Array<{
      volumeName?: string;
      volumeSnapshotName?: string;
      persistentVolumeClaim?: {
        metadata?: KubeMetadata;
        spec?: {
          storageClassName?: string;
          volumeName?: string;
        };
      };
    }>;
  };
  status?: {
    readyToUse?: boolean;
  };
}

export interface KubeVirtVirtualMachineRestore {
  metadata?: KubeMetadata;
  spec?: {
    target?: {
      apiGroup?: string;
      kind?: string;
      name?: string;
    };
    virtualMachineSnapshotName?: string;
  };
  status?: {
    complete?: boolean;
    conditions?: KubeCondition[];
    deletedDataVolumes?: string[];
    restoreTime?: string;
    restores?: Array<{
      persistentVolumeClaim?: string;
      volumeName?: string;
      volumeSnapshotName?: string;
    }>;
  };
}

export interface KubeStorageVolumeSnapshotContent {
  metadata?: KubeMetadata;
  spec?: {
    driver?: string;
    source?: {
      volumeHandle?: string;
    };
    volumeSnapshotRef?: {
      name?: string;
      namespace?: string;
    };
  };
}

export interface KubeLonghornVolume {
  metadata?: KubeMetadata;
  spec?: {
    size?: string | number;
    frontend?: string;
    disableFrontend?: boolean;
    numberOfReplicas?: number;
    accessMode?: string;
    migratable?: boolean;
    encrypted?: boolean;
    diskSelector?: string[];
    nodeSelector?: string[];
    dataEngine?: string;
    backupTargetName?: string;
  };
  status?: {
    state?: string;
    robustness?: string;
    currentNodeID?: string;
    ownerID?: string;
    frontendDisabled?: boolean;
    restoreRequired?: boolean;
    restoreInitiated?: boolean;
    kubernetesStatus?: {
      pvName?: string;
      pvcName?: string;
      namespace?: string;
    };
  };
}

export interface KubeLonghornSnapshot {
  metadata?: KubeMetadata;
  spec?: {
    volume?: string;
    createSnapshot?: boolean;
    labels?: Record<string, string>;
  };
  status?: {
    readyToUse?: boolean;
    creationTime?: string;
    error?: string;
    labels?: Record<string, string>;
    size?: number;
    restoreSize?: number;
    markRemoved?: boolean;
    userCreated?: boolean;
  };
}

export interface KubeLonghornBackup {
  metadata?: KubeMetadata;
  spec?: {
    snapshotName?: string;
    labels?: Record<string, string>;
    backupMode?: string;
  };
  status?: {
    state?: string;
    progress?: number;
    error?: string;
    url?: string;
    snapshotName?: string;
    snapshotCreatedAt?: string;
    backupCreatedAt?: string;
    size?: string;
    labels?: Record<string, string>;
    volumeName?: string;
    volumeSize?: string;
    volumeCreated?: string;
    backupTargetName?: string;
  };
}

export interface KubeLonghornBackupVolume {
  metadata?: KubeMetadata;
  status?: {
    volumeName?: string;
  };
}

export interface KubePersistentVolumeClaim {
  apiVersion?: string;
  kind?: string;
  metadata?: KubeMetadata & {
    finalizers?: string[];
  };
  spec?: {
    accessModes?: string[];
    resources?: {
      requests?: {
        storage?: string;
      };
    };
    selector?: unknown;
    storageClassName?: string;
    volumeMode?: string;
    volumeName?: string;
    dataSource?: unknown;
    dataSourceRef?: unknown;
  };
  status?: {
    phase?: string;
  };
}

export interface KubePersistentVolume {
  apiVersion?: string;
  kind?: string;
  metadata?: KubeMetadata & {
    finalizers?: string[];
  };
  spec?: {
    accessModes?: string[];
    capacity?: {
      storage?: string;
    };
    claimRef?: {
      apiVersion?: string;
      kind?: string;
      name?: string;
      namespace?: string;
      resourceVersion?: string;
      uid?: string;
    };
    csi?: {
      driver?: string;
      fsType?: string;
      nodeStageSecretRef?: {
        name?: string;
        namespace?: string;
      };
      volumeAttributes?: Record<string, string>;
      volumeHandle?: string;
    };
    mountOptions?: string[];
    persistentVolumeReclaimPolicy?: string;
    storageClassName?: string;
    volumeMode?: string;
  };
  status?: {
    phase?: string;
  };
}

export interface VmOperation {
  type: OperationType;
  name: string;
  phase: string;
  createdAt?: string;
  message?: string;
  snapshotName?: string;
}

export interface VirtualMachineSummary {
  id: string;
  uid?: string;
  name: string;
  namespace: string;
  createdAt?: string;
  powerState: VmPowerState;
  printableStatus: string;
  ready: boolean | null;
  nodeName?: string;
  ipAddresses: string[];
  runStrategy: string;
  conditions: KubeCondition[];
  activeOperations: VmOperation[];
}

export interface VirtualMachineSnapshotSummary {
  name: string;
  namespace: string;
  createdAt?: string;
  sourceName?: string;
  volumeName?: string;
  readyToUse: boolean | null;
  phase: string;
  message?: string;
  restoreBlockedReason?: string;
  conditions: KubeCondition[];
  size?: number;
  labels?: Record<string, string>;
}

export interface VirtualMachineBackupSummary {
  name: string;
  namespace: string;
  volumeName?: string;
  createdAt?: string;
  snapshotName?: string;
  readyToUse: boolean | null;
  phase: string;
  progress?: number;
  message?: string;
  backupMode?: string;
  size?: string;
  volumeSize?: string;
  labels?: Record<string, string>;
}

export interface VirtualMachineRestoreSummary {
  name: string;
  namespace: string;
  createdAt?: string;
  targetName?: string;
  snapshotName?: string;
  complete: boolean | null;
  phase: string;
  message?: string;
  conditions: KubeCondition[];
}

export interface VirtualMachineRootDiskSummary {
  pvcName: string;
  pvName: string;
  volumeName: string;
  storageClassName?: string;
  size?: string;
  volumeMode?: string;
}

export interface VirtualMachineRollbackSummary {
  pvName: string;
  volumeName?: string;
  pvcName?: string;
  createdAt?: string;
  expiresAt?: string;
}

export interface VirtualMachineDetail extends VirtualMachineSummary {
  rootDisk?: VirtualMachineRootDiskSummary;
  protectionError?: string;
  snapshots: VirtualMachineSnapshotSummary[];
  backups: VirtualMachineBackupSummary[];
  rollbacks: VirtualMachineRollbackSummary[];
  restores?: VirtualMachineRestoreSummary[];
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}
