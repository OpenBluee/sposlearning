import { initMaintenanceMonitor } from '/js/maintenance.js';

export const CONFIG = {
    AUTH_URL: "https://auth.sposlearning.cz",
    API_URL: "https://api.sposlearning.cz",
    BASE_URL: "https://dev.sposlearning.cz",
    ADMIN_URL: "https://admin.sposlearning.cz"
};

initMaintenanceMonitor(CONFIG.API_URL);
