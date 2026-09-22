# subscription_id from ARM_SUBSCRIPTION_ID; in CI the provider and backend authenticate with the GitHub OIDC token
# (ARM_USE_OIDC=true, ARM_USE_AZUREAD=true). No role assignments are created in this layer.
provider "azurerm" {
  resource_provider_registrations = "none"
  features {}
}
