export type VmPowerState = "online" | "offline" | "transitioning" | "unknown";

export type VmAction = "start" | "stop" | "reboot" | "force-stop";

export type OperationType = "snapshot" | "restore";

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
  readyToUse: boolean | null;
  phase: string;
  message?: string;
  restoreBlockedReason?: string;
  conditions: KubeCondition[];
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

export interface VirtualMachineDetail extends VirtualMachineSummary {
  snapshots: VirtualMachineSnapshotSummary[];
  restores: VirtualMachineRestoreSummary[];
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}
