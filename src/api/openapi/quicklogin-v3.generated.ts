// Generated from canonical protocol-v3.ts; SHA-256 0263d6f205e113cdc2da8661f2fdf8c7e5b52b5a41045b90633d8d5989625a38
export const QUICKLOGIN_V3_SCHEMAS: Record<string, Record<string, unknown>> = {
  "QuickloginV3Capabilities": {
    "type": "object",
    "required": [
      "protocolVersion",
      "supportedProtocolVersions",
      "minExtensionVersion",
      "serverBuild",
      "features"
    ],
    "properties": {
      "protocolVersion": {
        "type": "number",
        "const": 3
      },
      "supportedProtocolVersions": {
        "type": "array",
        "items": {
          "type": "number"
        }
      },
      "minExtensionVersion": {
        "type": "string"
      },
      "serverBuild": {
        "type": "string"
      },
      "features": {
        "type": "object",
        "required": [
          "reconcile",
          "operations",
          "receipts",
          "overview"
        ],
        "properties": {
          "reconcile": {
            "type": "boolean"
          },
          "operations": {
            "type": "boolean"
          },
          "receipts": {
            "type": "boolean"
          },
          "overview": {
            "type": "boolean"
          }
        }
      }
    }
  },
  "QuickloginV3RegistrationRequest": {
    "type": "object",
    "required": [
      "protocolVersion",
      "requestId",
      "registrationId",
      "client",
      "deviceName"
    ],
    "properties": {
      "protocolVersion": {
        "type": "number",
        "const": 3
      },
      "requestId": {
        "type": "string"
      },
      "registrationId": {
        "type": "string"
      },
      "client": {
        "$ref": "#/components/schemas/QuickloginV3ClientMetadata"
      },
      "deviceName": {
        "type": "string"
      },
      "deviceId": {
        "type": "string"
      },
      "resumeTicket": {
        "type": "string"
      }
    }
  },
  "QuickloginV3RegistrationResponse": {
    "type": "object",
    "required": [
      "deviceId",
      "snapshot"
    ],
    "properties": {
      "deviceId": {
        "type": "string"
      },
      "snapshot": {
        "$ref": "#/components/schemas/QuickloginV3DeviceSnapshot"
      }
    }
  },
  "QuickloginV3ReconcileRequest": {
    "type": "object",
    "required": [
      "protocolVersion",
      "requestId",
      "client",
      "observed",
      "reportEpoch",
      "clientReportSeq",
      "local"
    ],
    "properties": {
      "protocolVersion": {
        "type": "number",
        "const": 3
      },
      "requestId": {
        "type": "string"
      },
      "client": {
        "$ref": "#/components/schemas/QuickloginV3ClientMetadata"
      },
      "observed": {
        "anyOf": [
          {
            "$ref": "#/components/schemas/QuickloginV3ObservedVersions"
          },
          {
            "type": "null"
          }
        ]
      },
      "reportEpoch": {
        "type": "string"
      },
      "clientReportSeq": {
        "type": "number"
      },
      "local": {
        "$ref": "#/components/schemas/QuickloginV3LocalReport"
      }
    }
  },
  "QuickloginV3ReconcileResponse": {
    "type": "object",
    "required": [
      "snapshot",
      "receiptAck"
    ],
    "properties": {
      "snapshot": {
        "$ref": "#/components/schemas/QuickloginV3DeviceSnapshot"
      },
      "receiptAck": {
        "anyOf": [
          {
            "$ref": "#/components/schemas/QuickloginV3ReceiptAck"
          },
          {
            "type": "null"
          }
        ]
      }
    }
  },
  "QuickloginV3OperationRequest": {
    "type": "object",
    "required": [
      "protocolVersion",
      "requestId",
      "command",
      "idempotencyKey",
      "expected"
    ],
    "properties": {
      "protocolVersion": {
        "type": "number",
        "const": 3
      },
      "requestId": {
        "type": "string"
      },
      "command": {
        "$ref": "#/components/schemas/QuickloginV3OperationCommand"
      },
      "idempotencyKey": {
        "type": "string"
      },
      "expected": {
        "$ref": "#/components/schemas/QuickloginV3VersionTuple"
      },
      "enabled": {
        "type": "boolean"
      }
    }
  },
  "QuickloginV3OperationResponse": {
    "type": "object",
    "required": [
      "operation",
      "snapshot"
    ],
    "properties": {
      "operation": {
        "$ref": "#/components/schemas/QuickloginV3Operation"
      },
      "snapshot": {
        "$ref": "#/components/schemas/QuickloginV3DeviceSnapshot"
      }
    }
  },
  "QuickloginV3ExportRequest": {
    "type": "object",
    "required": [
      "protocolVersion",
      "requestId",
      "expected"
    ],
    "properties": {
      "protocolVersion": {
        "type": "number",
        "const": 3
      },
      "requestId": {
        "type": "string"
      },
      "expected": {
        "$ref": "#/components/schemas/QuickloginV3VersionTuple"
      }
    }
  },
  "QuickloginV3ExportEnvelope": {
    "allOf": [
      {
        "$ref": "#/components/schemas/QuickloginV3VersionTuple"
      },
      {
        "type": "object",
        "required": [
          "protocolVersion",
          "exportId",
          "createdAt",
          "applyBefore",
          "cookies"
        ],
        "properties": {
          "protocolVersion": {
            "type": "number",
            "const": 3
          },
          "exportId": {
            "type": "string"
          },
          "createdAt": {
            "type": "number"
          },
          "applyBefore": {
            "type": "number"
          },
          "cookies": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/QuickloginV3SsoCookie"
            }
          }
        }
      }
    ]
  },
  "QuickloginV3ReceiptRequest": {
    "type": "object",
    "required": [
      "protocolVersion",
      "requestId",
      "reportEpoch",
      "clientReportSeq",
      "receipt"
    ],
    "properties": {
      "protocolVersion": {
        "type": "number",
        "const": 3
      },
      "requestId": {
        "type": "string"
      },
      "reportEpoch": {
        "type": "string"
      },
      "clientReportSeq": {
        "type": "number"
      },
      "receipt": {
        "$ref": "#/components/schemas/QuickloginV3Receipt"
      }
    }
  },
  "QuickloginV3ReceiptAck": {
    "type": "object",
    "required": [
      "accepted",
      "exportId",
      "acceptedTuple",
      "reportEpoch",
      "clientReportSeq",
      "receivedAt",
      "reasonCode",
      "snapshot"
    ],
    "properties": {
      "accepted": {
        "type": "boolean"
      },
      "exportId": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "acceptedTuple": {
        "anyOf": [
          {
            "$ref": "#/components/schemas/QuickloginV3VersionTuple"
          },
          {
            "type": "null"
          }
        ]
      },
      "reportEpoch": {
        "type": "string"
      },
      "clientReportSeq": {
        "type": "number"
      },
      "receivedAt": {
        "type": "number"
      },
      "reasonCode": {
        "anyOf": [
          {
            "$ref": "#/components/schemas/QuickloginV3ReasonCode"
          },
          {
            "type": "null"
          }
        ]
      },
      "snapshot": {
        "$ref": "#/components/schemas/QuickloginV3DeviceSnapshot"
      }
    }
  },
  "QuickloginV3Overview": {
    "type": "object",
    "required": [
      "binding",
      "accountRevision",
      "masterEnabled",
      "deviceLimit",
      "used",
      "devices"
    ],
    "properties": {
      "binding": {
        "$ref": "#/components/schemas/QuickloginV3BindingFacts"
      },
      "accountRevision": {
        "type": "number"
      },
      "masterEnabled": {
        "type": "boolean"
      },
      "deviceLimit": {
        "type": "number"
      },
      "used": {
        "type": "number"
      },
      "devices": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/QuickloginV3DeviceSnapshot"
        }
      }
    }
  },
  "QuickloginV3ApiProblem": {
    "type": "object",
    "required": [
      "type",
      "title",
      "status",
      "detail",
      "code",
      "requestId",
      "retryAt",
      "action"
    ],
    "properties": {
      "type": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "status": {
        "type": "number"
      },
      "detail": {
        "type": "string"
      },
      "code": {
        "$ref": "#/components/schemas/QuickloginV3ReasonCode"
      },
      "requestId": {
        "type": "string"
      },
      "retryAt": {
        "anyOf": [
          {
            "type": "number"
          },
          {
            "type": "null"
          }
        ]
      },
      "action": {
        "$ref": "#/components/schemas/QuickloginV3ActionCode"
      }
    }
  },
  "QuickloginV3ApiMeta": {
    "type": "object",
    "required": [
      "protocolVersion",
      "requestId",
      "serverTime",
      "serverBuild"
    ],
    "properties": {
      "protocolVersion": {
        "type": "number",
        "const": 3
      },
      "requestId": {
        "type": "string"
      },
      "serverTime": {
        "type": "number"
      },
      "serverBuild": {
        "type": "string"
      }
    }
  },
  "QuickloginV3ClientMetadata": {
    "type": "object",
    "required": [
      "extensionVersion",
      "buildId",
      "browserVersion",
      "installationId"
    ],
    "properties": {
      "extensionVersion": {
        "type": "string"
      },
      "buildId": {
        "type": "string"
      },
      "browserVersion": {
        "type": "string"
      },
      "installationId": {
        "type": "string"
      }
    }
  },
  "QuickloginV3DeviceSnapshot": {
    "type": "object",
    "required": [
      "snapshotId",
      "serverTime",
      "observedAt",
      "freshUntil",
      "identity",
      "presence",
      "versions",
      "authorization",
      "binding",
      "cloud",
      "reportedLocal",
      "observation",
      "presentation",
      "capabilities"
    ],
    "properties": {
      "snapshotId": {
        "type": "string"
      },
      "serverTime": {
        "type": "number"
      },
      "observedAt": {
        "type": "number"
      },
      "freshUntil": {
        "type": "number"
      },
      "identity": {
        "type": "object",
        "required": [
          "deviceId",
          "installationId",
          "deviceName"
        ],
        "properties": {
          "deviceId": {
            "type": "string"
          },
          "installationId": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "deviceName": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          }
        }
      },
      "presence": {
        "type": "object",
        "required": [
          "lastSeenAt",
          "lastIp"
        ],
        "properties": {
          "lastSeenAt": {
            "anyOf": [
              {
                "type": "number"
              },
              {
                "type": "null"
              }
            ]
          },
          "lastIp": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          }
        }
      },
      "versions": {
        "$ref": "#/components/schemas/QuickloginV3VersionVector"
      },
      "authorization": {
        "type": "object",
        "required": [
          "state",
          "policy",
          "disabledReason",
          "masterEnabled",
          "deviceEnabled",
          "deviceLimit",
          "used"
        ],
        "properties": {
          "state": {
            "$ref": "#/components/schemas/QuickloginV3AuthorizationState"
          },
          "policy": {
            "$ref": "#/components/schemas/QuickloginV3PolicyState"
          },
          "disabledReason": {
            "type": [
              "string",
              "null"
            ],
            "enum": [
              "user",
              "quota_reduced",
              null
            ]
          },
          "masterEnabled": {
            "type": "boolean"
          },
          "deviceEnabled": {
            "type": "boolean"
          },
          "deviceLimit": {
            "type": "number"
          },
          "used": {
            "type": "number"
          }
        }
      },
      "binding": {
        "$ref": "#/components/schemas/QuickloginV3BindingFacts"
      },
      "cloud": {
        "$ref": "#/components/schemas/QuickloginV3CloudFacts"
      },
      "reportedLocal": {
        "anyOf": [
          {
            "$ref": "#/components/schemas/QuickloginV3ReportedLocal"
          },
          {
            "type": "null"
          }
        ]
      },
      "observation": {
        "$ref": "#/components/schemas/QuickloginV3ObservationState"
      },
      "presentation": {
        "$ref": "#/components/schemas/QuickloginV3Presentation"
      },
      "capabilities": {
        "type": "object",
        "required": [
          "canEnsure",
          "canRetry",
          "canExport",
          "canEnable",
          "canUseExistingSession"
        ],
        "properties": {
          "canEnsure": {
            "type": "boolean"
          },
          "canRetry": {
            "type": "boolean"
          },
          "canExport": {
            "type": "boolean"
          },
          "canEnable": {
            "type": "boolean"
          },
          "canUseExistingSession": {
            "type": "boolean"
          }
        }
      }
    }
  },
  "QuickloginV3ObservedVersions": {
    "type": "object",
    "required": [
      "generation",
      "bindingEpoch",
      "credentialRevision",
      "sessionVersion",
      "deviceRevision"
    ],
    "properties": {
      "generation": {
        "type": "number"
      },
      "bindingEpoch": {
        "anyOf": [
          {
            "type": "number"
          },
          {
            "type": "null"
          }
        ]
      },
      "credentialRevision": {
        "anyOf": [
          {
            "type": "number"
          },
          {
            "type": "null"
          }
        ]
      },
      "sessionVersion": {
        "type": "number"
      },
      "deviceRevision": {
        "type": "number"
      }
    }
  },
  "QuickloginV3LocalReport": {
    "type": "object",
    "required": [
      "enabledIntent",
      "mode",
      "cookieState",
      "receipt"
    ],
    "properties": {
      "enabledIntent": {
        "type": "boolean"
      },
      "mode": {
        "type": "string",
        "enum": [
          "automatic",
          "manual"
        ]
      },
      "cookieState": {
        "$ref": "#/components/schemas/QuickloginV3CookieState"
      },
      "receipt": {
        "anyOf": [
          {
            "$ref": "#/components/schemas/QuickloginV3Receipt"
          },
          {
            "type": "null"
          }
        ]
      },
      "schoolAccess": {
        "$ref": "#/components/schemas/QuickloginV3SchoolAccess"
      }
    }
  },
  "QuickloginV3OperationCommand": {
    "type": "string",
    "enum": [
      "ensure_session",
      "retry_session",
      "set_enabled"
    ]
  },
  "QuickloginV3VersionTuple": {
    "type": "object",
    "required": [
      "deviceId",
      "generation",
      "bindingEpoch",
      "credentialRevision",
      "sessionVersion"
    ],
    "properties": {
      "deviceId": {
        "type": "string"
      },
      "generation": {
        "type": "number"
      },
      "bindingEpoch": {
        "type": "number"
      },
      "credentialRevision": {
        "type": "number"
      },
      "sessionVersion": {
        "type": "number"
      }
    }
  },
  "QuickloginV3Operation": {
    "type": "object",
    "required": [
      "operationId",
      "command",
      "versions",
      "state",
      "stage",
      "attempt",
      "createdAt",
      "startedAt",
      "deadlineAt",
      "completedAt",
      "retryAt",
      "resultCode",
      "cancelReason"
    ],
    "properties": {
      "operationId": {
        "type": "string"
      },
      "command": {
        "$ref": "#/components/schemas/QuickloginV3OperationCommand"
      },
      "versions": {
        "$ref": "#/components/schemas/QuickloginV3VersionTuple"
      },
      "state": {
        "$ref": "#/components/schemas/QuickloginV3OperationState"
      },
      "stage": {
        "anyOf": [
          {
            "$ref": "#/components/schemas/QuickloginV3OperationStage"
          },
          {
            "type": "null"
          }
        ]
      },
      "attempt": {
        "type": "number"
      },
      "createdAt": {
        "type": "number"
      },
      "startedAt": {
        "anyOf": [
          {
            "type": "number"
          },
          {
            "type": "null"
          }
        ]
      },
      "deadlineAt": {
        "anyOf": [
          {
            "type": "number"
          },
          {
            "type": "null"
          }
        ]
      },
      "completedAt": {
        "anyOf": [
          {
            "type": "number"
          },
          {
            "type": "null"
          }
        ]
      },
      "retryAt": {
        "anyOf": [
          {
            "type": "number"
          },
          {
            "type": "null"
          }
        ]
      },
      "resultCode": {
        "anyOf": [
          {
            "$ref": "#/components/schemas/QuickloginV3ReasonCode"
          },
          {
            "type": "null"
          }
        ]
      },
      "cancelReason": {
        "anyOf": [
          {
            "$ref": "#/components/schemas/QuickloginV3ReasonCode"
          },
          {
            "type": "null"
          }
        ]
      }
    }
  },
  "QuickloginV3SsoCookie": {
    "type": "object",
    "required": [
      "name",
      "value",
      "domain",
      "path",
      "secure",
      "httpOnly",
      "sameSite",
      "expires"
    ],
    "properties": {
      "name": {
        "type": "string"
      },
      "value": {
        "type": "string"
      },
      "domain": {
        "type": "string",
        "enum": [
          "sso.cqu.edu.cn",
          ".sso.cqu.edu.cn"
        ]
      },
      "path": {
        "type": "string"
      },
      "secure": {
        "type": "boolean"
      },
      "httpOnly": {
        "type": "boolean"
      },
      "sameSite": {
        "type": "string",
        "enum": [
          "Strict",
          "Lax",
          "None"
        ]
      },
      "expires": {
        "type": "number"
      }
    }
  },
  "QuickloginV3Receipt": {
    "allOf": [
      {
        "$ref": "#/components/schemas/QuickloginV3VersionTuple"
      },
      {
        "type": "object",
        "required": [
          "exportId",
          "result",
          "verifiedAt"
        ],
        "properties": {
          "exportId": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "result": {
            "type": "string",
            "enum": [
              "applied",
              "foreign",
              "permission_denied",
              "write_failed",
              "missing",
              "manual"
            ]
          },
          "verifiedAt": {
            "anyOf": [
              {
                "type": "number"
              },
              {
                "type": "null"
              }
            ]
          }
        }
      }
    ]
  },
  "QuickloginV3ReasonCode": {
    "type": "string",
    "enum": [
      "AUTH_RECONNECT_REQUIRED",
      "DEVICE_REVOKED",
      "MASTER_DISABLED",
      "DEVICE_DISABLED",
      "QUOTA_BLOCKED",
      "SERVICE_PAUSED",
      "BINDING_UNBOUND",
      "BINDING_UPDATING",
      "BINDING_CHANGED",
      "CREDENTIALS_REJECTED",
      "INTERACTION_REQUIRED",
      "STALE_SNAPSHOT",
      "SESSION_CHANGED",
      "RECONCILING",
      "RATE_LIMITED",
      "VERIFICATION_COOLDOWN",
      "SCHOOL_UNREACHABLE",
      "WAF_CHALLENGE",
      "OTP_SEND_FAILED",
      "OTP_TIMEOUT",
      "CONTAINER_UNAVAILABLE",
      "INTERNAL_STATE_UNAVAILABLE",
      "LOCAL_PERMISSION_DENIED",
      "LOCAL_COOKIE_CONFLICT",
      "LOCAL_WRITE_FAILED",
      "PROTOCOL_UNSUPPORTED",
      "CLIENT_UPDATE_REQUIRED",
      "CONTRACT_INVALID",
      "UNKNOWN_SERVER_ERROR",
      "IDEMPOTENCY_CONFLICT",
      "INVALID_REQUEST",
      "FORBIDDEN",
      "BLOCKED_UNKNOWN",
      "OPERATION_CANCELLED",
      "OPERATION_TIMEOUT"
    ]
  },
  "QuickloginV3BindingFacts": {
    "type": "object",
    "required": [
      "state",
      "credentialsState",
      "evidenceAt",
      "evidenceKind",
      "evidenceCredentialRevision",
      "bindingTransitionId"
    ],
    "properties": {
      "state": {
        "$ref": "#/components/schemas/QuickloginV3BindingState"
      },
      "credentialsState": {
        "$ref": "#/components/schemas/QuickloginV3CredentialsState"
      },
      "evidenceAt": {
        "anyOf": [
          {
            "type": "number"
          },
          {
            "type": "null"
          }
        ]
      },
      "evidenceKind": {
        "type": "string",
        "enum": [
          "first_factor_success",
          "password_rejected",
          "session_reuse",
          "none"
        ]
      },
      "evidenceCredentialRevision": {
        "anyOf": [
          {
            "type": "number"
          },
          {
            "type": "null"
          }
        ]
      },
      "bindingTransitionId": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      }
    }
  },
  "QuickloginV3ActionCode": {
    "type": "string",
    "enum": [
      "none",
      "connect_auth",
      "update_extension",
      "open_auth",
      "enable_device",
      "manage_devices",
      "resume_automatic",
      "switch_to_quicklogin",
      "reconcile",
      "bind_school",
      "update_password",
      "complete_verification",
      "retry_session",
      "fix_permissions",
      "retry_local",
      "confirm_receipt",
      "disable"
    ]
  },
  "QuickloginV3VersionVector": {
    "type": "object",
    "required": [
      "generation",
      "bindingEpoch",
      "credentialRevision",
      "sessionVersion",
      "accountRevision",
      "deviceRevision",
      "bindingRevision"
    ],
    "properties": {
      "generation": {
        "type": "number"
      },
      "bindingEpoch": {
        "anyOf": [
          {
            "type": "number"
          },
          {
            "type": "null"
          }
        ]
      },
      "credentialRevision": {
        "anyOf": [
          {
            "type": "number"
          },
          {
            "type": "null"
          }
        ]
      },
      "sessionVersion": {
        "type": "number"
      },
      "accountRevision": {
        "type": "number"
      },
      "deviceRevision": {
        "type": "number"
      },
      "bindingRevision": {
        "anyOf": [
          {
            "type": "number"
          },
          {
            "type": "null"
          }
        ]
      }
    }
  },
  "QuickloginV3AuthorizationState": {
    "type": "string",
    "enum": [
      "disconnected",
      "authorizing",
      "authorized",
      "refreshing_token",
      "reconnect_required",
      "revoked"
    ]
  },
  "QuickloginV3PolicyState": {
    "type": "string",
    "enum": [
      "enabled",
      "master_off",
      "device_off",
      "quota_blocked",
      "service_paused"
    ]
  },
  "QuickloginV3CloudFacts": {
    "type": "object",
    "required": [
      "state",
      "operationId",
      "stage",
      "loginAt",
      "lastValidatedAt",
      "usableUntil",
      "retryAt",
      "reasonCode",
      "deadlineAt"
    ],
    "properties": {
      "state": {
        "$ref": "#/components/schemas/QuickloginV3CloudState"
      },
      "operationId": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "stage": {
        "anyOf": [
          {
            "$ref": "#/components/schemas/QuickloginV3OperationStage"
          },
          {
            "type": "null"
          }
        ]
      },
      "loginAt": {
        "anyOf": [
          {
            "type": "number"
          },
          {
            "type": "null"
          }
        ]
      },
      "lastValidatedAt": {
        "anyOf": [
          {
            "type": "number"
          },
          {
            "type": "null"
          }
        ]
      },
      "usableUntil": {
        "anyOf": [
          {
            "type": "number"
          },
          {
            "type": "null"
          }
        ]
      },
      "retryAt": {
        "anyOf": [
          {
            "type": "number"
          },
          {
            "type": "null"
          }
        ]
      },
      "reasonCode": {
        "anyOf": [
          {
            "$ref": "#/components/schemas/QuickloginV3ReasonCode"
          },
          {
            "type": "null"
          }
        ]
      },
      "deadlineAt": {
        "anyOf": [
          {
            "type": "number"
          },
          {
            "type": "null"
          }
        ]
      }
    }
  },
  "QuickloginV3ReportedLocal": {
    "type": "object",
    "required": [
      "reportEpoch",
      "clientReportSeq",
      "cookieState",
      "receipt",
      "receivedAt",
      "verificationAge",
      "acknowledgedAt",
      "enabledIntent",
      "mode",
      "schoolAccess",
      "client"
    ],
    "properties": {
      "reportEpoch": {
        "type": "string"
      },
      "clientReportSeq": {
        "type": "number"
      },
      "cookieState": {
        "$ref": "#/components/schemas/QuickloginV3CookieState"
      },
      "receipt": {
        "anyOf": [
          {
            "$ref": "#/components/schemas/QuickloginV3Receipt"
          },
          {
            "type": "null"
          }
        ]
      },
      "receivedAt": {
        "type": "number"
      },
      "verificationAge": {
        "anyOf": [
          {
            "type": "number"
          },
          {
            "type": "null"
          }
        ]
      },
      "acknowledgedAt": {
        "anyOf": [
          {
            "type": "number"
          },
          {
            "type": "null"
          }
        ]
      },
      "enabledIntent": {
        "type": "boolean"
      },
      "mode": {
        "type": "string",
        "enum": [
          "automatic",
          "manual"
        ]
      },
      "schoolAccess": {
        "$ref": "#/components/schemas/QuickloginV3SchoolAccess"
      },
      "client": {
        "anyOf": [
          {
            "$ref": "#/components/schemas/QuickloginV3ClientMetadata"
          },
          {
            "type": "null"
          }
        ]
      }
    }
  },
  "QuickloginV3ObservationState": {
    "type": "string",
    "enum": [
      "fresh",
      "checking",
      "stale",
      "unreachable"
    ]
  },
  "QuickloginV3Presentation": {
    "type": "object",
    "required": [
      "statusCode",
      "title",
      "detail",
      "reasonCode",
      "actionCode",
      "actionTarget",
      "nextCheckAt",
      "freshUntil"
    ],
    "properties": {
      "statusCode": {
        "$ref": "#/components/schemas/QuickloginV3StatusCode"
      },
      "title": {
        "type": "string"
      },
      "detail": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "reasonCode": {
        "anyOf": [
          {
            "$ref": "#/components/schemas/QuickloginV3ReasonCode"
          },
          {
            "type": "null"
          }
        ]
      },
      "actionCode": {
        "$ref": "#/components/schemas/QuickloginV3ActionCode"
      },
      "actionTarget": {
        "$ref": "#/components/schemas/QuickloginV3ActionTarget"
      },
      "nextCheckAt": {
        "anyOf": [
          {
            "type": "number"
          },
          {
            "type": "null"
          }
        ]
      },
      "freshUntil": {
        "anyOf": [
          {
            "type": "number"
          },
          {
            "type": "null"
          }
        ]
      }
    }
  },
  "QuickloginV3CookieState": {
    "type": "string",
    "enum": [
      "unknown",
      "missing",
      "applying",
      "applied",
      "foreign",
      "manual",
      "permission_denied",
      "write_failed"
    ]
  },
  "QuickloginV3SchoolAccess": {
    "type": "string",
    "enum": [
      "unverified",
      "accepted",
      "login_form_seen"
    ]
  },
  "QuickloginV3OperationState": {
    "type": "string",
    "enum": [
      "queued",
      "running",
      "succeeded",
      "retry_wait",
      "blocked",
      "cancelled"
    ]
  },
  "QuickloginV3OperationStage": {
    "type": "string",
    "enum": [
      "waiting_capacity",
      "waiting_verification_lease",
      "launching_browser",
      "authenticating",
      "waiting_verification",
      "validating_session",
      "saving_session"
    ]
  },
  "QuickloginV3BindingState": {
    "type": "string",
    "enum": [
      "unbound",
      "updating",
      "bound",
      "unknown"
    ]
  },
  "QuickloginV3CredentialsState": {
    "type": "string",
    "enum": [
      "unknown",
      "verified",
      "rejected",
      "interaction_required"
    ]
  },
  "QuickloginV3CloudState": {
    "type": "string",
    "enum": [
      "absent",
      "queued",
      "logging_in",
      "ready",
      "refreshing",
      "retry_wait",
      "blocked",
      "expired",
      "paused",
      "revoked"
    ]
  },
  "QuickloginV3StatusCode": {
    "type": "string",
    "enum": [
      "disabled",
      "disconnecting",
      "revoked",
      "disconnected",
      "authorizing",
      "reconnect_required",
      "update_required",
      "service_upgrading",
      "master_off",
      "device_off",
      "quota_blocked",
      "service_paused",
      "manual",
      "foreign",
      "unreachable",
      "checking",
      "unbound",
      "binding_updating",
      "credentials_rejected",
      "interaction_required",
      "preparing",
      "refreshing",
      "retry_wait",
      "syncing",
      "permission_denied",
      "write_failed",
      "pending_ack",
      "usable_credentials_rejected",
      "usable_retry_wait",
      "ready",
      "unknown"
    ]
  },
  "QuickloginV3ActionTarget": {
    "type": [
      "string",
      "null"
    ],
    "enum": [
      "/settings",
      "/settings?quicklogin=1",
      "/settings?cqu=bind",
      "/settings?cqu=repair",
      "/settings?cqu=verify",
      null
    ]
  }
};
