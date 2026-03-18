/*
 * Stub ghostty.h — minimal API surface needed by my-term.
 * This provides type/function declarations matching what ghostty.zig expects.
 */
#ifndef GHOSTTY_H
#define GHOSTTY_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Opaque handles */
typedef void* ghostty_config_t;
typedef void* ghostty_app_t;
typedef void* ghostty_surface_config_t;
typedef void* ghostty_surface_t;

typedef enum {
    GHOSTTY_SPLIT_HORIZONTAL = 0,
    GHOSTTY_SPLIT_VERTICAL = 1,
} ghostty_split_direction_e;

/* Config */
ghostty_config_t ghostty_config_new(void);
void ghostty_config_free(ghostty_config_t cfg);
void ghostty_config_set(ghostty_config_t cfg, const char* key, const char* value, size_t value_len);

/* App */
ghostty_app_t ghostty_app_new(ghostty_config_t cfg);
void ghostty_app_free(ghostty_app_t app);

/* Surface config */
ghostty_surface_config_t ghostty_surface_config_new(void);
void ghostty_surface_config_free(ghostty_surface_config_t cfg);
void ghostty_surface_config_set(ghostty_surface_config_t cfg, const char* key, const char* value, size_t value_len);
void ghostty_surface_config_set_size(ghostty_surface_config_t cfg, uint16_t cols, uint16_t rows);

/* Surface lifecycle */
ghostty_surface_t ghostty_app_surface_new(ghostty_app_t app, ghostty_surface_config_t cfg);
void ghostty_surface_free(ghostty_surface_t surface);

/* Surface operations */
void ghostty_surface_set_size(ghostty_surface_t surface, uint16_t cols, uint16_t rows);
void ghostty_surface_write(ghostty_surface_t surface, const char* data, size_t len);
size_t ghostty_surface_cwd(ghostty_surface_t surface, char* buf, size_t buf_len);
void* ghostty_surface_metal_layer(ghostty_surface_t surface);
void ghostty_surface_set_focus(ghostty_surface_t surface, int focused);
void ghostty_surface_key(ghostty_surface_t surface, void* event);
void ghostty_surface_scroll(ghostty_surface_t surface, double dx, double dy);
void ghostty_surface_mouse(ghostty_surface_t surface, void* event);
size_t ghostty_surface_title(ghostty_surface_t surface, char* buf, size_t buf_len);
int ghostty_surface_has_exited(ghostty_surface_t surface);
int ghostty_surface_exit_code(ghostty_surface_t surface);
void ghostty_surface_split(ghostty_surface_t surface, ghostty_split_direction_e direction);
size_t ghostty_surface_selection(ghostty_surface_t surface, char* buf, size_t buf_len);
void ghostty_surface_paste(ghostty_surface_t surface, const char* text, size_t len);

#ifdef __cplusplus
}
#endif

#endif /* GHOSTTY_H */
