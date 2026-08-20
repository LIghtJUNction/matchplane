#![forbid(unsafe_code)]

//! A bounded bridge from immutable MatchPlane tool declarations to Rig tools.
//!
//! The bridge deliberately does not model identity, contact data, payment, or
//! provider credentials. Callers construct an [`AgentToolScope`] from the
//! already-authorized platform path and immutable subplatform manifest, then
//! provide an executor that enforces the server-side capability boundary.

use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    pin::Pin,
    sync::Arc,
};

use rig_core::{
    tool::{PortableDynamicTool, ToolExecutionError, ToolOutput},
    wasm_compat::WasmBoxedFuture,
};
use serde_json::Value;
use thiserror::Error;

/// A path-scoped, immutable allowlist for one Agent invocation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentToolScope {
    platform_path: String,
    declared_tools: BTreeSet<String>,
}

impl AgentToolScope {
    /// Creates a scope from an active platform path and its manifest-declared tools.
    ///
    /// # Errors
    ///
    /// Returns [`AgentToolCatalogError`] when the platform path or a declared
    /// tool name cannot be safely represented in the MatchPlane Agent envelope.
    pub fn new(
        platform_path: impl Into<String>,
        declared_tools: impl IntoIterator<Item = String>,
    ) -> Result<Self, AgentToolCatalogError> {
        let platform_path = platform_path.into();
        if !is_platform_path(&platform_path) {
            return Err(AgentToolCatalogError::InvalidPlatformPath(platform_path));
        }
        let mut tools = BTreeSet::new();
        for tool in declared_tools {
            if !is_tool_name(&tool) {
                return Err(AgentToolCatalogError::InvalidToolName(tool));
            }
            tools.insert(tool);
        }
        Ok(Self {
            platform_path,
            declared_tools: tools,
        })
    }

    /// Returns the active platform path carried to every tool execution.
    #[must_use]
    pub fn platform_path(&self) -> &str {
        &self.platform_path
    }

    /// Returns whether the immutable manifest declared a tool for this scope.
    #[must_use]
    pub fn permits(&self, tool_name: &str) -> bool {
        self.declared_tools.contains(tool_name)
    }
}

/// A provider-facing description of an MCP tool that the current manifest permits.
#[derive(Clone, Debug)]
pub struct AgentToolSpec {
    /// The bounded, manifest-declared MCP tool name.
    pub name: String,
    /// A model-visible description with no credentials or hidden authority.
    pub description: String,
    /// The JSON Schema for owned tool arguments.
    pub parameters: Value,
}

impl AgentToolSpec {
    /// Creates an MCP tool description to expose through Rig.
    #[must_use]
    pub fn new(name: impl Into<String>, description: impl Into<String>, parameters: Value) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            parameters,
        }
    }
}

/// A typed failure returned by the host-owned MCP executor.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum AgentToolExecutionError {
    /// The caller's current scoped authority does not permit the requested operation.
    #[error("tool execution was denied: {0}")]
    Denied(String),
    /// An already-authorized upstream MCP call failed.
    #[error("tool execution failed upstream: {0}")]
    Upstream(String),
}

/// A future returned by a host-owned, scope-validating MCP executor.
pub type ScopedToolFuture =
    Pin<Box<dyn Future<Output = Result<Value, AgentToolExecutionError>> + Send + 'static>>;

/// Executes a manifest-declared MCP tool after MatchPlane has validated scope and identity.
pub trait ScopedMcpExecutor: Send + Sync {
    /// Executes a single tool invocation with an owned scope, tool name, and JSON arguments.
    fn execute(
        &self,
        scope: AgentToolScope,
        tool_name: String,
        arguments: Value,
    ) -> ScopedToolFuture;
}

/// A Rig-ready catalog containing only the tools declared by the active subplatform manifest.
#[derive(Clone, Debug)]
pub struct AgentToolCatalog {
    scope: AgentToolScope,
    tools: BTreeMap<String, AgentToolSpec>,
}

impl AgentToolCatalog {
    /// Validates and stores the tool specifications exposed to one Agent invocation.
    ///
    /// # Errors
    ///
    /// Returns [`AgentToolCatalogError`] if a tool is undeclared, duplicated, or
    /// has a non-object JSON Schema.
    pub fn new(
        scope: AgentToolScope,
        tools: impl IntoIterator<Item = AgentToolSpec>,
    ) -> Result<Self, AgentToolCatalogError> {
        let mut catalog = BTreeMap::new();
        for tool in tools {
            if !scope.permits(&tool.name) {
                return Err(AgentToolCatalogError::UndeclaredTool(tool.name));
            }
            if !tool.parameters.is_object() {
                return Err(AgentToolCatalogError::InvalidParameters(tool.name));
            }
            if catalog.contains_key(&tool.name) {
                return Err(AgentToolCatalogError::DuplicateTool(tool.name));
            }
            catalog.insert(tool.name.clone(), tool);
        }
        Ok(Self {
            scope,
            tools: catalog,
        })
    }

    /// Exposes the validated tool specifications as executable Rig dynamic tools.
    #[must_use]
    pub fn rig_tools(&self, executor: Arc<dyn ScopedMcpExecutor>) -> Vec<PortableDynamicTool> {
        self.tools
            .values()
            .cloned()
            .map(|tool| {
                let scope = self.scope.clone();
                let tool_name = tool.name.clone();
                let callback_executor = Arc::clone(&executor);
                PortableDynamicTool::new(
                    tool.name,
                    tool.description,
                    tool.parameters,
                    move |arguments| {
                        let scope = scope.clone();
                        let tool_name = tool_name.clone();
                        let executor = Arc::clone(&callback_executor);
                        Box::pin(async move {
                            executor
                                .execute(scope, tool_name, arguments)
                                .await
                                .map(ToolOutput::json)
                                .map_err(map_execution_error)
                        })
                            as WasmBoxedFuture<'static, Result<ToolOutput, ToolExecutionError>>
                    },
                )
            })
            .collect()
    }
}

/// A validation error raised while translating a MatchPlane manifest to Rig tools.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum AgentToolCatalogError {
    /// The platform path is not a canonical mounted route.
    #[error("platform path is invalid: {0}")]
    InvalidPlatformPath(String),
    /// The manifest contains an unsafe or malformed MCP tool name.
    #[error("tool name is invalid: {0}")]
    InvalidToolName(String),
    /// A requested definition was not declared by the active manifest.
    #[error("tool is not declared for this platform: {0}")]
    UndeclaredTool(String),
    /// The input contains duplicate provider-facing tool names.
    #[error("tool is declared more than once: {0}")]
    DuplicateTool(String),
    /// Rig tools require an object JSON Schema for arguments.
    #[error("tool parameters must be an object schema: {0}")]
    InvalidParameters(String),
}

fn map_execution_error(error: AgentToolExecutionError) -> ToolExecutionError {
    match error {
        AgentToolExecutionError::Denied(message) => ToolExecutionError::permission_denied(message),
        AgentToolExecutionError::Upstream(message) => ToolExecutionError::provider(message),
    }
}

fn is_platform_path(path: &str) -> bool {
    path == "/"
        || (path.starts_with('/')
            && path.split('/').skip(1).all(|segment| {
                !segment.is_empty()
                    && segment.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                    })
            }))
}

fn is_tool_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    (2..=128).contains(&bytes.len())
        && bytes
            .first()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'.' | b'_' | b':' | b'-')
        })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;

    #[derive(Debug, Default)]
    struct RecordingExecutor {
        calls: Mutex<Vec<(AgentToolScope, String, Value)>>,
    }

    impl ScopedMcpExecutor for RecordingExecutor {
        fn execute(
            &self,
            scope: AgentToolScope,
            tool_name: String,
            arguments: Value,
        ) -> ScopedToolFuture {
            self.calls
                .lock()
                .expect("test executor mutex should not be poisoned")
                .push((scope, tool_name, arguments.clone()));
            Box::pin(async move { Ok(json!({ "accepted": arguments })) })
        }
    }

    #[test]
    fn catalog_should_reject_a_tool_not_declared_by_the_active_manifest() {
        let scope = AgentToolScope::new("/market/auto", ["inventory.search".to_owned()])
            .expect("scope fixture should be valid");
        let result = AgentToolCatalog::new(
            scope,
            [AgentToolSpec::new(
                "billing.charge",
                "Charge a card",
                json!({ "type": "object" }),
            )],
        );

        assert_eq!(
            result.expect_err("undeclared tool must be rejected"),
            AgentToolCatalogError::UndeclaredTool("billing.charge".to_owned())
        );
    }

    #[tokio::test]
    async fn rig_tool_should_preserve_the_platform_scope_for_the_host_executor() {
        let scope = AgentToolScope::new("/market/auto", ["inventory.search".to_owned()])
            .expect("scope fixture should be valid");
        let catalog = AgentToolCatalog::new(
            scope,
            [AgentToolSpec::new(
                "inventory.search",
                "Search only the active subplatform inventory",
                json!({ "type": "object", "properties": { "query": { "type": "string" } } }),
            )],
        )
        .expect("declared tool fixture should be valid");
        let executor = Arc::new(RecordingExecutor::default());
        let tool = catalog
            .rig_tools(executor.clone())
            .pop()
            .expect("catalog should create one Rig tool");
        let arguments = json!({ "query": "family car" });
        let result = tool
            .execute(arguments.clone())
            .await
            .expect("host executor should return a tool result");

        assert_eq!(result.as_json(), Some(&json!({ "accepted": arguments })));
        let calls = executor
            .calls
            .lock()
            .expect("test executor mutex should not be poisoned");
        assert_eq!(calls[0].0.platform_path(), "/market/auto");
        assert_eq!(calls[0].1, "inventory.search");
    }
}
