/*
 * Stub libghostty implementation.
 * Provides no-op / minimal implementations so my-term can compile and show its UI.
 * Terminal surfaces are placeholders — no actual terminal emulation.
 */
#include "include/ghostty.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

/* Fake config — just a malloc'd tag */
typedef struct { int dummy; } fake_config;
typedef struct { int dummy; } fake_app;
typedef struct { int dummy; } fake_surface_config;
typedef struct {
    int exited;
    int exit_code;
    char cwd[4096];
    char title[256];
} fake_surface;

ghostty_config_t ghostty_config_new(void) {
    fake_config* c = calloc(1, sizeof(fake_config));
    return (ghostty_config_t)c;
}

void ghostty_config_free(ghostty_config_t cfg) {
    free(cfg);
}

void ghostty_config_set(ghostty_config_t cfg, const char* key, const char* value, size_t value_len) {
    (void)cfg; (void)key; (void)value; (void)value_len;
}

ghostty_app_t ghostty_app_new(ghostty_config_t cfg) {
    (void)cfg;
    fake_app* a = calloc(1, sizeof(fake_app));
    return (ghostty_app_t)a;
}

void ghostty_app_free(ghostty_app_t app) {
    free(app);
}

ghostty_surface_config_t ghostty_surface_config_new(void) {
    fake_surface_config* c = calloc(1, sizeof(fake_surface_config));
    return (ghostty_surface_config_t)c;
}

void ghostty_surface_config_free(ghostty_surface_config_t cfg) {
    free(cfg);
}

void ghostty_surface_config_set(ghostty_surface_config_t cfg, const char* key, const char* value, size_t value_len) {
    (void)cfg; (void)key; (void)value; (void)value_len;
}

void ghostty_surface_config_set_size(ghostty_surface_config_t cfg, uint16_t cols, uint16_t rows) {
    (void)cfg; (void)cols; (void)rows;
}

ghostty_surface_t ghostty_app_surface_new(ghostty_app_t app, ghostty_surface_config_t cfg) {
    (void)app; (void)cfg;
    fake_surface* s = calloc(1, sizeof(fake_surface));
    snprintf(s->title, sizeof(s->title), "my-term");
    return (ghostty_surface_t)s;
}

void ghostty_surface_free(ghostty_surface_t surface) {
    free(surface);
}

void ghostty_surface_set_size(ghostty_surface_t surface, uint16_t cols, uint16_t rows) {
    (void)surface; (void)cols; (void)rows;
}

void ghostty_surface_write(ghostty_surface_t surface, const char* data, size_t len) {
    (void)surface; (void)data; (void)len;
}

size_t ghostty_surface_cwd(ghostty_surface_t surface, char* buf, size_t buf_len) {
    (void)surface; (void)buf; (void)buf_len;
    return 0;
}

void* ghostty_surface_metal_layer(ghostty_surface_t surface) {
    (void)surface;
    return NULL; /* No Metal layer in stub */
}

void ghostty_surface_set_focus(ghostty_surface_t surface, int focused) {
    (void)surface; (void)focused;
}

void ghostty_surface_key(ghostty_surface_t surface, void* event) {
    (void)surface; (void)event;
}

void ghostty_surface_scroll(ghostty_surface_t surface, double dx, double dy) {
    (void)surface; (void)dx; (void)dy;
}

void ghostty_surface_mouse(ghostty_surface_t surface, void* event) {
    (void)surface; (void)event;
}

size_t ghostty_surface_title(ghostty_surface_t surface, char* buf, size_t buf_len) {
    fake_surface* s = (fake_surface*)surface;
    size_t len = strlen(s->title);
    if (len > buf_len) len = buf_len;
    memcpy(buf, s->title, len);
    return len;
}

int ghostty_surface_has_exited(ghostty_surface_t surface) {
    fake_surface* s = (fake_surface*)surface;
    return s->exited;
}

int ghostty_surface_exit_code(ghostty_surface_t surface) {
    fake_surface* s = (fake_surface*)surface;
    return s->exit_code;
}

void ghostty_surface_split(ghostty_surface_t surface, ghostty_split_direction_e direction) {
    (void)surface; (void)direction;
}

size_t ghostty_surface_selection(ghostty_surface_t surface, char* buf, size_t buf_len) {
    (void)surface; (void)buf; (void)buf_len;
    return 0;
}

void ghostty_surface_paste(ghostty_surface_t surface, const char* text, size_t len) {
    (void)surface; (void)text; (void)len;
}
