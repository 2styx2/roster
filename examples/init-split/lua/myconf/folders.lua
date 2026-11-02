-- Folders of Hosts in the Sidebar, kept here (read-only in the app).

roster.folders.add({ name = "Lab", hosts = { "esx-02", "esx-03" } })
-- A Folder changes through its collection's functions, never by editing what get() returned.
roster.folders.add_hosts("Lab", { "esx-04" })
