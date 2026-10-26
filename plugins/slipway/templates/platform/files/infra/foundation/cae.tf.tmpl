# Container Apps environment shared by every repository of the organisation (one network, one default domain). Each
# repository's apps are container apps named <project>-<app> in this environment, created by its own infra/apps/<app>.
resource "azurerm_container_app_environment" "this" {
  name                       = local.cae_name
  location                   = data.azurerm_resource_group.env.location
  resource_group_name        = data.azurerm_resource_group.env.name
  logs_destination           = "log-analytics"
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  tags                       = local.tags
}
